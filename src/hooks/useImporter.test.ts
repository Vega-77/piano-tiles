import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBackend } from '../cloud/testing';
import { fakeChart } from '../songs/testing';
import { getSongStore } from '../songs/store';
import { renderHook, settle } from './testing';
import { useImporter } from './useImporter';

/** A song on this device that is not published yet. (Each test has its own id: the device's store is shared by them all.) */
async function draft(id: string) {
  await (await getSongStore()).save(fakeChart(id, { audio: `audio-${id}.mp3`, savedAt: 100 }), new Blob([`sound of ${id}`], { type: 'audio/mpeg' }));
}

async function setup() {
  const backend = createFakeBackend();
  const refresh = vi.fn(async () => undefined);
  return { backend, refresh, ...(await renderHook(() => useImporter(refresh, backend))) };
}

describe('publishing from the tuning screen', () => {
  it('publishes the song for everyone and reads the library again', async () => {
    await draft('p1');
    const { backend, refresh, result } = await setup();

    const kept = await settle(() => result.current.publish('p1'));

    expect(kept).toMatchObject({ id: 'p1', publishedAt: 100 });
    expect(backend.catalogue.songs.has('p1')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.working).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('says why when it could not, and leaves the song as it was', async () => {
    await draft('p2');
    const { backend, result } = await setup();
    backend.catalogue.offline = true;

    const kept = await settle(() => result.current.publish('p2'));

    expect(kept).toBeUndefined();
    expect(result.current.error).toMatch(/reach the cloud/);
    expect((await (await getSongStore()).chart('p2')) as object).not.toHaveProperty('publishedAt');
  });

  it('says it is not on this device when the song is gone', async () => {
    const { result } = await setup();
    expect(await settle(() => result.current.publish('nothing-like-it'))).toBeUndefined();
    expect(result.current.error).toMatch(/no longer on this device/);
  });

  it('takes the song down, keeping it here as a draft', async () => {
    await draft('p3');
    const { backend, result } = await setup();
    await settle(() => result.current.publish('p3'));

    const kept = await settle(() => result.current.unpublish('p3'));

    expect(kept).toMatchObject({ id: 'p3' });
    expect(kept).not.toHaveProperty('publishedAt');
    expect(backend.catalogue.songs.has('p3')).toBe(false);
    expect(await (await getSongStore()).audio('p3')).toBeDefined();
  });
});
