import type { Song } from '../types';
import { songFromChart, validateChart } from './chart';

/** Folder of imported songs, relative to the page: `songs/index.json` lists them, `songs/<id>/` holds each one. */
export const SONGS_FOLDER = 'songs/';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImportedLibrary {
  songs: Song[];
  /** One message per song that couldn't be loaded. The rest still load. */
  problems: string[];
}

async function getJson(fetcher: Fetcher, url: string): Promise<{ status: number; body: unknown }> {
  // Charts change when a song is re-analysed, so never trust a cached copy.
  const response = await fetcher(url, { cache: 'no-store' });
  if (!response.ok) return { status: response.status, body: null };
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Loads the songs that were imported from recordings (see `tools/analyze.py`): the ids in
 * `songs/index.json`, then each one's `chart.json`. A site with no imported songs has no manifest
 * at all, which is fine and simply gives an empty library. `taken` are ids already in use.
 */
export async function loadImportedSongs(
  fetcher: Fetcher = (input, init) => fetch(input, init),
  base: string = document.baseURI,
  taken: readonly string[] = [],
): Promise<ImportedLibrary> {
  const problems: string[] = [];
  const at = (path: string) => new URL(path, base).href;

  let ids: string[] = [];
  try {
    const manifest = await getJson(fetcher, at(`${SONGS_FOLDER}index.json`));
    if (manifest.status === 404 || manifest.status === 403) return { songs: [], problems };
    const list = (manifest.body as { songs?: unknown } | null)?.songs;
    if (!Array.isArray(list) || !list.every((id) => typeof id === 'string')) {
      return { songs: [], problems: ['The song list (songs/index.json) is not valid.'] };
    }
    ids = list as string[];
  } catch {
    // Offline, or a static host with nothing to serve: play the built-in songs.
    return { songs: [], problems };
  }

  const used = new Set(taken);
  const songs: Song[] = [];
  await Promise.all(
    ids.map(async (id, index) => {
      try {
        const folder = at(`${SONGS_FOLDER}${encodeURIComponent(id)}/`);
        const { status, body } = await getJson(fetcher, `${folder}chart.json`);
        if (!body) throw new Error(status === 404 ? 'its chart.json is missing' : 'its chart.json could not be read');
        const chart = validateChart(body);
        if (chart.id !== id) throw new Error(`its chart is for "${chart.id}"`);
        songs[index] = songFromChart(chart, folder);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        problems.push(`Couldn't load "${id}": ${reason}`);
      }
    }),
  );

  const loaded: Song[] = [];
  for (const song of songs) {
    if (!song) continue; // (a hole where one failed to load)
    if (used.has(song.id)) {
      problems.push(`Couldn't load "${song.id}": another song already has that id`);
      continue;
    }
    used.add(song.id);
    loaded.push(song);
  }
  loaded.sort((a, b) => a.difficulty - b.difficulty || a.title.localeCompare(b.title));
  return { songs: loaded, problems };
}
