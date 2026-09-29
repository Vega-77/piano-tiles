import { publicationOf, validateChart, type ChartFile } from '../songs/chart';
import type { SongStore } from '../songs/store';
import type { Catalog, RemoteSong, Transfer } from './types';

/**
 * Keeping this device's songs in step with the published ones. Every song here says, in
 * `publishedAt`, which published version it is a copy of, and `savedAt` says whether it has been
 * changed since (see `publicationOf`). That is all that is needed to tell what to do:
 *
 * - a published song this device has not got is added (the chart only: the audio, which is the
 *   big part, is fetched when the song is first played),
 * - a copy that is behind the published version is brought up to date, unless it has been changed
 *   here (an admin's unpublished work is never overwritten),
 * - a copy of a song that has been taken down is dropped, unless it has been changed here, in
 *   which case it stays as a draft,
 * - a draft (never published) is left alone.
 */
export type Step =
  | { kind: 'add'; song: RemoteSong }
  | { kind: 'update'; song: RemoteSong }
  | { kind: 'drop'; id: string }
  | { kind: 'draft'; id: string };

/** What to do to `local` (the songs saved here) to match `remote` (the published ones). */
export function planCatalog(local: readonly ChartFile[], remote: readonly RemoteSong[]): Step[] {
  const here = new Map(local.map((chart) => [chart.id, chart]));
  const there = new Map(remote.map((song) => [song.id, song]));
  const steps: Step[] = [];

  for (const song of remote) {
    const copy = here.get(song.id);
    if (!copy) steps.push({ kind: 'add', song });
    else if (copy.publishedAt !== song.savedAt && publicationOf(copy) === 'live') steps.push({ kind: 'update', song });
  }
  for (const copy of local) {
    if (copy.publishedAt === undefined || there.has(copy.id)) continue;
    steps.push(publicationOf(copy) === 'live' ? { kind: 'drop', id: copy.id } : { kind: 'draft', id: copy.id });
  }
  return steps;
}

/** The chart as it is kept here: the published one, marked as a copy of that version. */
const copyOf = (song: RemoteSong): ChartFile => ({ ...song.chart, savedAt: song.savedAt, publishedAt: song.savedAt });

/** The saved charts that can be read (an unreadable one is not this code's to judge). */
async function savedCharts(store: SongStore): Promise<ChartFile[]> {
  const charts: ChartFile[] = [];
  for (const raw of await store.charts()) {
    try {
      charts.push(validateChart(raw));
    } catch {
      // (It shows up as a problem when the library is read.)
    }
  }
  return charts;
}

export interface Synced {
  /** The published songs, by id. */
  published: Map<string, RemoteSong>;
  /** Whether anything on this device was changed, so the library needs reading again. */
  changed: boolean;
}

/** Reads the published songs and brings this device's songs in step with them. Rejects if the cloud can't be reached. */
export async function syncCatalog(store: SongStore, catalog: Catalog): Promise<Synced> {
  const remote = await catalog.list();
  const local = await savedCharts(store);
  const steps = planCatalog(local, remote);

  for (const step of steps) {
    if (step.kind === 'add') {
      await store.save(copyOf(step.song));
    } else if (step.kind === 'update') {
      // (A different sound is a different song; the old audio goes and the new is fetched when it is played.)
      const old = local.find((chart) => chart.id === step.song.id);
      if (old?.audio !== step.song.chart.audio) await store.remove(step.song.id);
      await store.save(copyOf(step.song));
    } else if (step.kind === 'drop') {
      await store.remove(step.id);
    } else {
      const { publishedAt: _gone, ...draft } = local.find((chart) => chart.id === step.id)!;
      await store.save(draft);
    }
  }
  return { published: new Map(remote.map((song) => [song.id, song])), changed: steps.length > 0 };
}

/**
 * Makes sure the audio of a published song is on this device, fetching it if it is not (a song
 * added by `syncCatalog` has its chart only). Does nothing for a song that has its audio.
 */
export async function ensureAudio(store: SongStore, catalog: Catalog, song: RemoteSong, transfer?: Transfer): Promise<void> {
  if (await store.audio(song.id)) return;
  const raw = await store.chart(song.id);
  if (raw === undefined) return; // (taken down since)
  const chart = validateChart(raw);
  if (chart.audio !== song.audio.name) return; // (a different song of the same id: not this one's sound)
  await store.save(chart, await catalog.getAudio(song.id, song.audio, transfer));
}
