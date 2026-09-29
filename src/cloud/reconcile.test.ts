import { describe, expect, it } from 'vitest';
import type { ChartFile } from '../songs/chart';
import { createMemoryStore, type SongStore } from '../songs/store';
import { fakeChart } from '../songs/testing';
import { ensureAudio, planCatalog, syncCatalog } from './reconcile';
import { createMemoryCatalog, type MemoryCatalog } from './testing';
import type { RemoteSong } from './types';

const sound = (text = 'sound') => new Blob([text], { type: 'audio/mpeg' });

/** A published song, as the cloud has it. */
function published(id: string, savedAt: number, audio = `audio-${id}.mp3`): RemoteSong {
  return {
    id,
    savedAt,
    chart: fakeChart(id, { audio, savedAt }),
    audio: { name: audio, type: 'audio/mpeg', size: 5, parts: 1 },
  };
}

/** A song as kept on a device. */
const local = (id: string, savedAt: number, publishedAt?: number, audio = `audio-${id}.mp3`): ChartFile =>
  fakeChart(id, { audio, savedAt, ...(publishedAt !== undefined && { publishedAt }) });

describe('what to do to bring a device in step with the published songs', () => {
  it('adds a published song the device has not got', () => {
    const song = published('a', 10);
    expect(planCatalog([], [song])).toEqual([{ kind: 'add', song }]);
  });

  it('brings a copy that is behind up to date', () => {
    const song = published('a', 20);
    expect(planCatalog([local('a', 10, 10)], [song])).toEqual([{ kind: 'update', song }]);
  });

  it('does nothing for a copy that is as published', () => {
    expect(planCatalog([local('a', 10, 10)], [published('a', 10)])).toEqual([]);
  });

  it('never overwrites work that was changed here since it was published', () => {
    expect(planCatalog([local('a', 15, 10)], [published('a', 20)])).toEqual([]);
  });

  it('leaves a draft alone, even if a published song has its id', () => {
    expect(planCatalog([local('a', 5)], [published('a', 10)])).toEqual([]);
    expect(planCatalog([local('a', 5)], [])).toEqual([]);
  });

  it('drops the copy of a song that was taken down, or keeps it as a draft if it was changed here', () => {
    expect(planCatalog([local('a', 10, 10)], [])).toEqual([{ kind: 'drop', id: 'a' }]);
    expect(planCatalog([local('a', 15, 10)], [])).toEqual([{ kind: 'draft', id: 'a' }]);
  });
});

describe('bringing a device in step', () => {
  async function setup(...saved: [ChartFile, Blob?][]): Promise<{ store: SongStore; catalog: MemoryCatalog }> {
    const store = createMemoryStore();
    for (const [chart, audio] of saved) await store.save(chart, audio);
    return { store, catalog: createMemoryCatalog() };
  }
  const publish = async (catalog: MemoryCatalog, song: RemoteSong, audio = sound()) => {
    await catalog.putAudio(song.id, song.audio.name, audio);
    await catalog.putSong(song.chart, song.audio);
  };

  it('saves the chart of a new song as a copy of the published one, without its audio', async () => {
    const { store, catalog } = await setup();
    await publish(catalog, published('a', 10));

    const result = await syncCatalog(store, catalog);

    expect(result.changed).toBe(true);
    expect([...result.published.keys()]).toEqual(['a']);
    expect(await store.chart('a')).toMatchObject({ id: 'a', savedAt: 10, publishedAt: 10 });
    expect(await store.audio('a')).toBeUndefined();
  });

  it('says nothing changed when nothing did', async () => {
    const { store, catalog } = await setup([local('a', 10, 10), sound()]);
    await publish(catalog, published('a', 10));
    expect((await syncCatalog(store, catalog)).changed).toBe(false);
  });

  it('keeps the audio when the sound is the same, and drops it when the song is another recording', async () => {
    const same = await setup([local('a', 10, 10), sound('mine')]);
    await publish(same.catalog, published('a', 20));
    await syncCatalog(same.store, same.catalog);
    expect(await same.store.chart('a')).toMatchObject({ savedAt: 20, publishedAt: 20 });
    expect(await same.store.audio('a')).toBeDefined();

    const other = await setup([local('a', 10, 10), sound('mine')]);
    await publish(other.catalog, published('a', 20, 'audio-new.mp3'));
    await syncCatalog(other.store, other.catalog);
    expect(await other.store.chart('a')).toMatchObject({ audio: 'audio-new.mp3', publishedAt: 20 });
    expect(await other.store.audio('a')).toBeUndefined();
  });

  it('drops a taken-down song, and turns changed work into a draft', async () => {
    const { store, catalog } = await setup([local('gone', 10, 10), sound()], [local('mine', 15, 10), sound()], [local('draft', 5), sound()]);

    const result = await syncCatalog(store, catalog);

    expect(result.changed).toBe(true);
    expect(await store.chart('gone')).toBeUndefined();
    expect(await store.audio('gone')).toBeUndefined();
    expect(await store.chart('mine')).toMatchObject({ id: 'mine', savedAt: 15 });
    expect(await store.chart('mine')).not.toHaveProperty('publishedAt');
    expect(await store.audio('mine')).toBeDefined();
    expect(await store.chart('draft')).toBeDefined();
  });

  it('fails without touching the device when the cloud cannot be reached', async () => {
    const { store, catalog } = await setup([local('a', 10, 10), sound()]);
    catalog.offline = true;
    await expect(syncCatalog(store, catalog)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await store.chart('a')).toBeDefined();
  });

  it('ignores a saved chart it cannot read', async () => {
    const { store, catalog } = await setup();
    await store.save({ id: 'broken' } as unknown as ChartFile);
    await publish(catalog, published('a', 10));
    await expect(syncCatalog(store, catalog)).resolves.toMatchObject({ changed: true });
    expect(await store.chart('broken')).toBeDefined();
  });
});

describe('getting the audio of a published song', () => {
  it('fetches it once, for a song whose chart is all the device has', async () => {
    const store = createMemoryStore();
    const catalog = createMemoryCatalog();
    const song = published('a', 10);
    await catalog.putAudio('a', song.audio.name, sound('hello'));
    await catalog.putSong(song.chart, song.audio);
    await syncCatalog(store, catalog);

    await ensureAudio(store, catalog, song);
    await ensureAudio(store, catalog, song);

    expect(await (await store.audio('a'))!.text()).toBe('hello');
    expect(catalog.calls.filter((call) => call.startsWith('getAudio'))).toEqual(['getAudio a']);
    expect(await store.chart('a')).toMatchObject({ savedAt: 10, publishedAt: 10 }); // (the chart is as it was)
  });

  it('does nothing for a song taken down meanwhile, or one that is a different recording under the same id', async () => {
    const store = createMemoryStore();
    const catalog = createMemoryCatalog();
    await ensureAudio(store, catalog, published('a', 10));
    expect(catalog.calls).toEqual([]);

    await store.save(local('a', 10, 10, 'audio-other.mp3'));
    await ensureAudio(store, catalog, published('a', 10));
    expect(catalog.calls).toEqual([]);
    expect(await store.audio('a')).toBeUndefined();
  });
});
