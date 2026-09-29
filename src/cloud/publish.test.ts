import { describe, expect, it } from 'vitest';
import { ImportError } from '../songs/errors';
import { createMemoryStore } from '../songs/store';
import { fakeChart } from '../songs/testing';
import { MAX_CLOUD_AUDIO_BYTES } from './config';
import { CloudError } from './errors';
import { publishSong, unpublishSong } from './publish';
import { createMemoryCatalog } from './testing';

const sound = (text = 'sound') => new Blob([text], { type: 'audio/mpeg' });

async function draft(id = 'a', audio = 'audio-a.mp3', savedAt = 100) {
  const store = createMemoryStore();
  await store.save(fakeChart(id, { audio, savedAt }), sound('mine'));
  return { store, catalog: createMemoryCatalog() };
}

describe('publishing a song', () => {
  it('puts the audio up first and then the chart, and marks the song here as the published version', async () => {
    const { store, catalog } = await draft();

    const kept = await publishSong('a', store, catalog);

    expect(catalog.calls).toEqual(['list', 'putAudio a', 'putSong a']);
    expect(kept).toMatchObject({ id: 'a', savedAt: 100, publishedAt: 100 });
    expect(await store.chart('a')).toMatchObject({ savedAt: 100, publishedAt: 100 });
    expect(catalog.songs.get('a')).toMatchObject({ savedAt: 100 });
    expect(catalog.audio.has('a|audio-a.mp3')).toBe(true);
  });

  it('publishes the chart without the mark that is only for copies kept on devices', async () => {
    const { store, catalog } = await draft();
    await store.save(fakeChart('a', { audio: 'audio-a.mp3', savedAt: 100, publishedAt: 50 }));

    await publishSong('a', store, catalog);

    expect(catalog.songs.get('a')!.chart).not.toHaveProperty('publishedAt');
  });

  it('replaces the published chart with the new one, and does not send the same sound twice', async () => {
    const { store, catalog } = await draft();
    await publishSong('a', store, catalog);
    await store.save(fakeChart('a', { audio: 'audio-a.mp3', savedAt: 200, title: 'Better' }));
    catalog.calls.length = 0;

    const kept = await publishSong('a', store, catalog);

    expect(catalog.calls).toEqual(['list', 'putSong a']);
    expect(kept.publishedAt).toBe(200);
    expect(catalog.songs.get('a')!.chart.title).toBe('Better');
    expect(catalog.songs.size).toBe(1);
  });

  it('publishes a different recording under a new id when another song has the id (one song, one chart)', async () => {
    const { store, catalog } = await draft('a', 'audio-mine.mp3');
    await catalog.putAudio('a', 'audio-theirs.mp3', sound('theirs'));
    await catalog.putSong(fakeChart('a', { audio: 'audio-theirs.mp3', savedAt: 5 }), { name: 'audio-theirs.mp3', type: 'audio/mpeg', size: 6, parts: 1 });

    const kept = await publishSong('a', store, catalog);

    expect(kept.id).not.toBe('a');
    expect(catalog.songs.get('a')!.chart.audio).toBe('audio-theirs.mp3');
    expect(catalog.songs.get(kept.id)!.chart.audio).toBe('audio-mine.mp3');
    expect(await store.chart('a')).toBeUndefined();
    expect(await store.chart(kept.id)).toMatchObject({ publishedAt: 100 });
    expect(await (await store.audio(kept.id))!.text()).toBe('mine');
  });

  it('refuses a song that is gone, has no audio here, or is too big to publish', async () => {
    const { store, catalog } = await draft();
    await expect(publishSong('nope', store, catalog)).rejects.toBeInstanceOf(ImportError);

    const bare = createMemoryStore();
    await bare.save(fakeChart('a', { savedAt: 1 }));
    await expect(publishSong('a', bare, catalog)).rejects.toBeInstanceOf(ImportError);

    const big = createMemoryStore();
    // (A blob that only says it is big: no need to hold that many bytes.)
    const huge = Object.defineProperty(sound(), 'size', { value: MAX_CLOUD_AUDIO_BYTES + 1 });
    await big.save(fakeChart('a', { savedAt: 1 }), huge);
    await expect(publishSong('a', big, catalog)).rejects.toBeInstanceOf(CloudError);
    expect(catalog.calls).toEqual([]);
  });

  it('leaves the song here as it was when the cloud cannot be reached', async () => {
    const { store, catalog } = await draft();
    catalog.offline = true;
    await expect(publishSong('a', store, catalog)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await store.chart('a')).not.toHaveProperty('publishedAt');
  });
});

describe('taking a song down', () => {
  it('removes it from the published songs and keeps it here as a draft, audio and all', async () => {
    const { store, catalog } = await draft();
    await publishSong('a', store, catalog);

    const kept = await unpublishSong('a', store, catalog);

    expect(catalog.songs.size).toBe(0);
    expect(kept).not.toHaveProperty('publishedAt');
    expect(await store.chart('a')).not.toHaveProperty('publishedAt');
    expect(await (await store.audio('a'))!.text()).toBe('mine');
  });

  it('is fine for a song that is not published', async () => {
    const { store, catalog } = await draft();
    await expect(unpublishSong('a', store, catalog)).resolves.toMatchObject({ id: 'a' });
    expect(catalog.calls).toEqual(['list']);
  });
});
