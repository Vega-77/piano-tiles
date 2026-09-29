// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadStoredSongs } from './library';
import { createMemoryStore, type SongStore } from './store';
import { fakeChart } from './testing';

async function storeWith(...charts: unknown[]): Promise<SongStore> {
  const store = createMemoryStore();
  for (const chart of charts) await store.save(chart as Parameters<SongStore['save']>[0]);
  return store;
}

describe('loading the songs saved on this device', () => {
  it('finds nothing, without complaint, when none are saved', async () => {
    expect(await loadStoredSongs(createMemoryStore())).toEqual({ songs: [], problems: [] });
  });

  it('loads every saved song and points each at its own stored audio', async () => {
    const store = await storeWith(fakeChart('zed', { difficulty: 1 }), fakeChart('alpha', { difficulty: 1, audio: 'a.mp3' }));
    const { songs, problems } = await loadStoredSongs(store);
    expect(problems).toEqual([]);
    expect(songs.map((s) => s.id)).toEqual(['alpha', 'zed']); // same difficulty: by title
    expect(songs[0].recording?.url).toBe('stored:alpha/a.mp3');
    expect(songs[1].recording?.url).toBe('stored:zed/audio-00000000.mp3');
  });

  it('orders songs from easiest to hardest', async () => {
    const store = await storeWith(fakeChart('hard', { difficulty: 4 }), fakeChart('easy', { difficulty: 1 }));
    expect((await loadStoredSongs(store)).songs.map((s) => s.id)).toEqual(['easy', 'hard']);
  });

  it('keeps going when one song is broken, and says which', async () => {
    const store = await storeWith(
      fakeChart('good'),
      fakeChart('empty', { title: 'Empty one', chart: '. . .' }),
      { ...fakeChart('bad'), title: 'Bad one', bpm: 9000 },
    );
    const { songs, problems } = await loadStoredSongs(store);
    expect(songs.map((s) => s.id)).toEqual(['good']);
    expect(problems).toEqual([
      expect.stringContaining('"Empty one"'),
      expect.stringContaining('"Bad one"'),
    ]);
  });

  it('says so, and carries on, when the saved songs cannot be read at all', async () => {
    const broken: SongStore = {
      ...createMemoryStore(),
      charts: async () => {
        throw new Error('locked');
      },
    };
    const { songs, problems } = await loadStoredSongs(broken);
    expect(songs).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});
