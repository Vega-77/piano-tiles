import type { Song } from '../types';
import { songFromChart, validateChart } from './chart';
import { storedFolder, type SongStore } from './store';

export interface StoredLibrary {
  songs: Song[];
  /** One message per song that couldn't be loaded. The rest still load. */
  problems: string[];
}

/**
 * The songs saved on this device, ready to play: easiest first, then by name. `taken` are ids the
 * built-in songs already use.
 */
export async function loadStoredSongs(store: SongStore, taken: readonly string[] = []): Promise<StoredLibrary> {
  const problems: string[] = [];
  const used = new Set(taken);
  const songs: Song[] = [];

  let saved: unknown[];
  try {
    saved = await store.charts();
  } catch {
    return { songs: [], problems: ["Couldn't read the songs saved on this device."] };
  }

  for (const raw of saved) {
    const name = (raw as { title?: unknown } | null)?.title;
    try {
      const chart = validateChart(raw);
      if (used.has(chart.id)) throw new Error('another song already has that id');
      songs.push(songFromChart(chart, storedFolder(chart.id)));
      used.add(chart.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`Couldn't load "${typeof name === 'string' ? name : 'a saved song'}": ${reason}`);
    }
  }

  songs.sort((a, b) => a.difficulty - b.difficulty || a.title.localeCompare(b.title));
  return { songs, problems };
}
