import { describe, expect, it, vi } from 'vitest';
import { createFakeBackend, type FakeBackend } from '../cloud/testing';
import type { RemoteSong } from '../cloud/types';
import type { Song } from '../types';
import { createMemoryStore } from '../songs/store';
import { fakeChart } from '../songs/testing';
import { renderHook, settle } from './testing';
import { useCatalog } from './useCatalog';

const sound = (text: string) => new Blob([text], { type: 'audio/mpeg' });
const song = (id: string) => ({ id }) as Song;

/** A song published from another device. */
async function publishThere(backend: FakeBackend, id: string, savedAt = 10, audio = `audio-${id}.mp3`) {
  const chart = fakeChart(id, { audio, savedAt });
  const stored = await backend.catalogue.putAudio(id, audio, sound(`sound of ${id}`));
  await backend.catalogue.putSong(chart, stored);
  return { id, savedAt, chart, audio: stored } satisfies RemoteSong;
}

async function setup(prepare?: (backend: FakeBackend) => Promise<void>) {
  const backend = createFakeBackend();
  await prepare?.(backend);
  const store = createMemoryStore();
  const refresh = vi.fn(async () => undefined);
  const view = await renderHook(() => useCatalog({ refresh, backend, store: async () => store }));
  return { backend, store, refresh, ...view };
}

describe('the songs everyone plays', () => {
  it('brings the published songs onto the device when the page opens, and reads the library again', async () => {
    const { store, refresh, result } = await setup((backend) => publishThere(backend, 'a').then(() => undefined));

    expect(result.current).toMatchObject({ syncing: false, error: null });
    expect(await store.chart('a')).toMatchObject({ id: 'a', publishedAt: 10 });
    expect(await store.audio('a')).toBeUndefined(); // (fetched when it is first played)
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the library alone when nothing changed', async () => {
    const { refresh, result } = await setup();
    expect(refresh).not.toHaveBeenCalled();

    await settle(() => result.current.sync());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says why it could not look, and tries again when asked', async () => {
    const { backend, refresh, result } = await setup(async (backend) => {
      await publishThere(backend, 'a');
      backend.catalogue.offline = true;
    });
    expect(result.current.error).toMatch(/reach the cloud/);
    expect(refresh).not.toHaveBeenCalled();

    backend.catalogue.offline = false;
    await settle(() => result.current.sync());

    expect(result.current.error).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('looks again when the connection comes back', async () => {
    const { backend, result } = await setup();
    const lists = () => backend.catalogue.calls.filter((call) => call === 'list').length;
    expect(lists()).toBe(1);

    await settle(() => window.dispatchEvent(new Event('online')));

    expect(lists()).toBe(2);
    expect(result.current.syncing).toBe(false);
  });

  it('does not run two looks at once', async () => {
    const { backend, result } = await setup();
    const before = backend.catalogue.calls.length;
    await settle(() => Promise.all([result.current.sync(), result.current.sync()]));
    expect(backend.catalogue.calls.length - before).toBe(1);
  });
});

describe('getting a song ready to play', () => {
  it('downloads the audio of a song that is only a chart here, once', async () => {
    const { backend, store, result } = await setup((backend) => publishThere(backend, 'a').then(() => undefined));
    const progress = vi.fn();

    await settle(() => result.current.prepare(song('a'), progress));
    await settle(() => result.current.prepare(song('a'), progress));

    expect(await (await store.audio('a'))!.text()).toBe('sound of a');
    expect(backend.catalogue.calls.filter((call) => call.startsWith('getAudio'))).toEqual(['getAudio a']);
  });

  it('asks the cloud about a song it has not heard of yet (the page has only just opened)', async () => {
    const { backend, store, result } = await setup();
    await publishThere(backend, 'late');

    await settle(() => result.current.prepare(song('late'), () => undefined));

    expect(await store.chart('late')).toMatchObject({ id: 'late' });
    expect(await (await store.audio('late'))!.text()).toBe('sound of late');
  });

  it('says the audio is missing for a song that is not published and has none', async () => {
    const { result } = await setup();
    await expect(settle(() => result.current.prepare(song('nope'), () => undefined))).rejects.toThrow(/no longer on this device/);
  });

  it('says so, in words, when the download fails', async () => {
    const { backend, result } = await setup((backend) => publishThere(backend, 'a').then(() => undefined));
    backend.catalogue.offline = true;

    await expect(settle(() => result.current.prepare(song('a'), () => undefined))).rejects.toThrow(/reach the cloud/);
  });
});
