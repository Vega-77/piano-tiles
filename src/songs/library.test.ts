import { describe, expect, it } from 'vitest';
import type { ChartFile } from './chart';
import { loadImportedSongs } from './library';

const BASE = 'https://example.test/app/';

function chart(id: string, overrides: Partial<ChartFile> = {}): ChartFile {
  return {
    version: 1, id, title: id.toUpperCase(), artist: 'Band', audio: 'audio-00000000.mp3', bpm: 120,
    rowsPerBeat: 2, offset: 0, duration: 30, difficulty: 2, hue: 10, hue2: 20, chart: 'x . x .', ...overrides,
  };
}

/** A fake server: paths (relative to the app) -> body, or a status number. Anything else is a 404. */
function server(files: Record<string, unknown>) {
  const requested: string[] = [];
  const fetcher = async (input: string) => {
    const path = input.replace(BASE, '');
    requested.push(path);
    const file = files[path];
    if (file === undefined) return new Response('not found', { status: 404 });
    if (typeof file === 'number') return new Response('nope', { status: file });
    if (typeof file === 'string') return new Response(file); // (not JSON)
    return new Response(JSON.stringify(file));
  };
  return { fetcher, requested };
}

describe('loading imported songs', () => {
  it('finds nothing, without complaint, when the site has no songs folder', async () => {
    const { fetcher } = server({});
    expect(await loadImportedSongs(fetcher, BASE)).toEqual({ songs: [], problems: [] });
  });

  it('copes with the network being down', async () => {
    const fetcher = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await loadImportedSongs(fetcher, BASE)).toEqual({ songs: [], problems: [] });
  });

  it('loads every song in the list and points each at its own audio', async () => {
    const { fetcher } = server({
      'songs/index.json': { songs: ['zed', 'alpha'] },
      'songs/zed/chart.json': chart('zed', { difficulty: 1 }),
      'songs/alpha/chart.json': chart('alpha', { difficulty: 1, audio: 'a.mp3' }),
    });
    const { songs, problems } = await loadImportedSongs(fetcher, BASE);
    expect(problems).toEqual([]);
    expect(songs.map((s) => s.id)).toEqual(['alpha', 'zed']); // same difficulty: by title
    expect(songs[0].recording?.url).toBe(`${BASE}songs/alpha/a.mp3`);
    expect(songs[1].recording?.url).toBe(`${BASE}songs/zed/audio-00000000.mp3`);
  });

  it('orders songs from easiest to hardest', async () => {
    const { fetcher } = server({
      'songs/index.json': { songs: ['hard', 'easy'] },
      'songs/hard/chart.json': chart('hard', { difficulty: 4 }),
      'songs/easy/chart.json': chart('easy', { difficulty: 1 }),
    });
    expect((await loadImportedSongs(fetcher, BASE)).songs.map((s) => s.id)).toEqual(['easy', 'hard']);
  });

  it('keeps going when one song is broken, and says which', async () => {
    const { fetcher } = server({
      'songs/index.json': { songs: ['good', 'gone', 'garbled', 'wrong', 'empty'] },
      'songs/good/chart.json': chart('good'),
      'songs/garbled/chart.json': 'this is not json',
      'songs/wrong/chart.json': chart('other'),
      'songs/empty/chart.json': chart('empty', { chart: '. . .' }),
    });
    const { songs, problems } = await loadImportedSongs(fetcher, BASE);
    expect(songs.map((s) => s.id)).toEqual(['good']);
    expect(problems.sort()).toEqual([
      expect.stringContaining('"empty"'),
      expect.stringContaining('"garbled"'),
      expect.stringContaining('"gone"'),
      expect.stringContaining('"wrong"'),
    ]);
    expect(problems.find((p) => p.includes('"gone"'))).toMatch(/missing/);
  });

  it('will not let an imported song take over the id of one that already exists', async () => {
    const { fetcher } = server({
      'songs/index.json': { songs: ['twinkle', 'fresh'] },
      'songs/twinkle/chart.json': chart('twinkle'),
      'songs/fresh/chart.json': chart('fresh'),
    });
    const { songs, problems } = await loadImportedSongs(fetcher, BASE, ['twinkle']);
    expect(songs.map((s) => s.id)).toEqual(['fresh']);
    expect(problems).toEqual([expect.stringContaining('another song already has that id')]);
  });

  it('reports a song list that makes no sense', async () => {
    const { fetcher } = server({ 'songs/index.json': { songs: 'nope' } });
    const { songs, problems } = await loadImportedSongs(fetcher, BASE);
    expect(songs).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it('asks for fresh copies, since a re-analysed chart replaces the old one', async () => {
    const seen: RequestInit[] = [];
    const inner = server({ 'songs/index.json': { songs: ['a'] }, 'songs/a/chart.json': chart('a') });
    const fetcher = (input: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return inner.fetcher(input);
    };
    await loadImportedSongs(fetcher, BASE);
    expect(seen.length).toBe(2);
    for (const init of seen) expect(init.cache).toBe('no-store');
  });
});
