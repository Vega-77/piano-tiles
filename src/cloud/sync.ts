import { validateChart, type ChartFile } from '../songs/chart';
import { Cancelled } from '../songs/errors';
import type { SongStore } from '../songs/store';
import { MAX_CLOUD_AUDIO_BYTES } from './config';
import type { RemovalLog } from './removals';
import type { CloudSongs, RemoteSong } from './types';

/** What one device knows about a song it has: enough to tell whether it is the newer copy. */
export interface LocalEntry {
  id: string;
  /** 0 for a song from before syncing existed. */
  savedAt: number;
}

export type SyncAction =
  /** Send this device's copy up. */
  | { kind: 'push'; id: string }
  /** Take the cloud's copy down. */
  | { kind: 'pull'; id: string }
  /** It was removed on another device. */
  | { kind: 'delete-local'; id: string }
  /** It was removed here (at `removedAt`) and the cloud still has it. */
  | { kind: 'delete-remote'; id: string; removedAt: number }
  /** A note of a removal that has been dealt with, or no longer matters. */
  | { kind: 'forget'; id: string };

/**
 * Works out what to do to bring this device and the cloud in line. The newer copy of a song wins
 * (by `savedAt`), and a removal counts as a change made when it happened, so a song edited after
 * it was removed elsewhere comes back, and one removed after its last edit goes away everywhere.
 * Songs with the same time are taken to be the same.
 */
export function planSync(
  local: readonly LocalEntry[],
  remote: readonly RemoteSong[],
  removed: ReadonlyMap<string, number>,
): SyncAction[] {
  const mine = new Map(local.map((entry) => [entry.id, entry]));
  const theirs = new Map(remote.map((song) => [song.id, song]));
  const ids = [...new Set([...mine.keys(), ...theirs.keys(), ...removed.keys()])].sort();

  const actions: SyncAction[] = [];
  for (const id of ids) {
    const here = mine.get(id);
    const there = theirs.get(id);
    const removedAt = removed.get(id);

    if (here) {
      // (Added or changed again since it was removed: the note is out of date.)
      if (removedAt !== undefined) actions.push({ kind: 'forget', id });
      if (!there) actions.push({ kind: 'push', id });
      else if (there.deleted) actions.push({ kind: here.savedAt > there.savedAt ? 'push' : 'delete-local', id });
      else if (here.savedAt > there.savedAt) actions.push({ kind: 'push', id });
      else if (here.savedAt < there.savedAt) actions.push({ kind: 'pull', id });
    } else if (there && !there.deleted) {
      if (removedAt !== undefined && removedAt > there.savedAt) {
        actions.push({ kind: 'delete-remote', id, removedAt }, { kind: 'forget', id });
      } else {
        if (removedAt !== undefined) actions.push({ kind: 'forget', id });
        actions.push({ kind: 'pull', id });
      }
    } else if (removedAt !== undefined) {
      actions.push({ kind: 'forget', id });
    }
  }
  return actions;
}

/** A song that couldn't be synced and stays on this device, and why. */
export interface Skipped {
  id: string;
  title: string;
  reason: string;
}

export interface SyncReport {
  pushed: string[];
  pulled: string[];
  /** Removed from this device because they were removed on another. */
  removedHere: string[];
  /** Removed from the cloud because they were removed on this device. */
  removedThere: string[];
  skipped: Skipped[];
}

export interface SyncDeps {
  store: SongStore;
  cloud: CloudSongs;
  removals: RemovalLog;
  /** The time, for stamping a song from before syncing existed. */
  now?: () => number;
  /** The biggest audio put in the cloud. */
  maxAudioBytes?: number;
  /** What is happening, in words, as it goes. */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The time a saved chart was last changed, or undefined if there is no such song (0 if it never had a time). */
function savedAtOf(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = (raw as { savedAt?: unknown }).savedAt;
  return typeof value === 'number' ? value : 0;
}

/**
 * Brings this device and the cloud in line: reads both, works out what differs (`planSync`), and
 * does it, one song at a time. It can be run again and again, and stopped part way (`signal`); what
 * was done stays done. A song in the cloud always has its audio (that goes up first), and is only
 * marked as changed once everything of it is there.
 */
export async function runSync({
  store,
  cloud,
  removals,
  now = Date.now,
  maxAudioBytes = MAX_CLOUD_AUDIO_BYTES,
  onProgress,
  signal,
}: SyncDeps): Promise<SyncReport> {
  const report: SyncReport = { pushed: [], pulled: [], removedHere: [], removedThere: [], skipped: [] };
  const check = () => {
    if (signal?.aborted) throw new Cancelled();
  };

  onProgress?.('Checking the cloud');
  const local: ChartFile[] = [];
  for (const raw of await store.charts()) {
    try {
      local.push(validateChart(raw));
    } catch {
      // A song that can't be read stays where it is: it isn't sent, and it isn't touched.
    }
  }
  const remote = new Map((await cloud.list()).map((song) => [song.id, song]));
  check();

  const known = new Map(local.map((chart) => [chart.id, chart]));
  const actions = planSync(
    local.map((chart) => ({ id: chart.id, savedAt: chart.savedAt ?? 0 })),
    [...remote.values()],
    removals.all(),
  );

  const skip = (id: string, title: string, reason: string) => report.skipped.push({ id, title, reason });
  const transfer = (label: string) => ({
    signal,
    progress: (fraction: number) => onProgress?.(`${label} ${Math.round(fraction * 100)}%`),
  });
  /** Whether the song here is still what the plan was made from (the player may have changed it meanwhile). */
  const unchanged = async (id: string) => savedAtOf(await store.chart(id)) === (known.has(id) ? (known.get(id)!.savedAt ?? 0) : undefined);

  for (const action of actions) {
    check();
    const { id } = action;
    switch (action.kind) {
      case 'push': {
        const chart = known.get(id)!;
        const audio = await store.audio(id);
        if (!audio) {
          skip(id, chart.title, "Its audio isn't on this device any more.");
          break;
        }
        if (audio.size > maxAudioBytes) {
          skip(id, chart.title, `Its audio is ${mb(audio.size)} MB, over the ${mb(maxAudioBytes)} MB the cloud takes. It stays on this device.`);
          break;
        }
        // (A song from before syncing gets its time now, on both sides, so the two copies agree.)
        let sending = chart;
        if (chart.savedAt === undefined) {
          sending = { ...chart, savedAt: now() };
          await store.save(sending);
        }
        const before = remote.get(id)?.audio ?? null;
        const stored =
          before && before.name === chart.audio && before.size === audio.size
            ? before
            : await cloud.putAudio(id, chart.audio, audio, transfer(`Sending “${chart.title}”`));
        check();
        await cloud.putSong(sending, stored);
        if (before && before.name !== stored.name) await cloud.dropAudio(id, before).catch(() => undefined);
        report.pushed.push(id);
        break;
      }

      case 'pull': {
        const song = remote.get(id)!;
        if (!song.chart || !song.audio) break; // (a note of a removal with nothing in it: nothing to take)
        if (!(await unchanged(id))) break; // (changed here meanwhile: the next sync sorts it out)
        const have = known.get(id);
        const blob =
          have && have.audio === song.chart.audio && (await store.audio(id))
            ? undefined
            : await cloud.getAudio(id, song.audio, transfer(`Fetching “${song.chart.title}”`));
        check();
        if (!(await unchanged(id))) break;
        await store.save(song.chart, blob);
        report.pulled.push(id);
        break;
      }

      case 'delete-local': {
        if (!(await unchanged(id))) break;
        await store.remove(id);
        report.removedHere.push(id);
        break;
      }

      case 'delete-remote': {
        await cloud.remove(id, action.removedAt, remote.get(id)?.audio ?? null);
        report.removedThere.push(id);
        break;
      }

      case 'forget':
        removals.drop(id);
        break;
    }
  }
  return report;
}
