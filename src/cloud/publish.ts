import { validateChart, type ChartFile } from '../songs/chart';
import { ImportError } from '../songs/errors';
import { uniqueId } from '../songs/importer';
import { MISSING_AUDIO, type SongStore } from '../songs/store';
import { MAX_CLOUD_AUDIO_BYTES } from './config';
import { CloudError } from './errors';
import type { Catalog, Transfer } from './types';

async function savedChart(store: SongStore, id: string): Promise<ChartFile> {
  const raw = await store.chart(id);
  if (raw === undefined) throw new ImportError('That song is no longer on this device.');
  try {
    return validateChart(raw);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : 'That song could not be read.');
  }
}

/** A published copy of the chart doesn't say it is one: that is only for the copies kept on devices. */
const forCatalog = ({ publishedAt: _mark, ...chart }: ChartFile): ChartFile => chart;

/**
 * Publishes a song on this device for everyone: its audio (unless the same sound is up already),
 * then its chart, so a song is never there without its sound. A song has one chart, so publishing
 * a song that is already published replaces it. Resolves with the song as it is kept here now,
 * marked as the published version (its id changes only if another song is published under it).
 */
export async function publishSong(id: string, store: SongStore, catalog: Catalog, transfer?: Transfer): Promise<ChartFile> {
  const chart = await savedChart(store, id);
  const audio = await store.audio(id);
  if (!audio) throw new ImportError(MISSING_AUDIO);
  if (audio.size > MAX_CLOUD_AUDIO_BYTES) {
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
    throw new CloudError(`This song's audio is ${mb(audio.size)} MB, and the most a published song can have is ${mb(MAX_CLOUD_AUDIO_BYTES)} MB.`);
  }

  const published = await catalog.list();
  const already = published.find((song) => song.id === id);
  let song = chart;
  if (already && already.audio.name !== chart.audio) {
    // Another recording is published under this id (a song added on another device with the same name): this one goes up as its own.
    const taken = new Set(published.map((other) => other.id));
    for (const raw of await store.charts()) {
      const used = (raw as { id?: unknown } | null)?.id;
      if (typeof used === 'string') taken.add(used);
    }
    song = { ...chart, id: uniqueId(id, taken) };
  }

  const stored = already?.audio.name === song.audio ? already.audio : await catalog.putAudio(song.id, song.audio, audio, transfer);
  const savedAt = song.savedAt ?? Date.now();
  await catalog.putSong(forCatalog({ ...song, savedAt }), stored);

  const kept: ChartFile = { ...song, savedAt, publishedAt: savedAt };
  await store.save(kept, song.id === id ? undefined : audio);
  if (song.id !== id) await store.remove(id);
  return kept;
}

/** Takes a song down, so it is no longer offered. It stays on this device, as a draft (and its leaderboard stays, ready for if it comes back). */
export async function unpublishSong(id: string, store: SongStore, catalog: Catalog): Promise<ChartFile> {
  const chart = await savedChart(store, id);
  const published = (await catalog.list()).find((song) => song.id === id);
  if (published) await catalog.remove(id, published.audio);
  const { publishedAt: _mark, ...draft } = chart;
  await store.save(draft);
  return draft;
}
