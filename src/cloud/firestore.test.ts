// @vitest-environment node
import type { Firestore } from 'firebase/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cancelled } from '../songs/errors';
import { fakeChart } from '../songs/testing';
import { CloudError } from './errors';
import { createFirestoreSongs, PART_BYTES, type FirestoreSdk } from './firestore';

class FakeBytes {
  constructor(private readonly data: Uint8Array) {}
  static fromUint8Array(data: Uint8Array) {
    return new FakeBytes(data.slice());
  }
  toUint8Array() {
    return this.data.slice();
  }
}

interface Ref {
  path: string;
}

/** The few Firestore calls the app makes, over a map of paths to documents. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const sdk = {
    Bytes: FakeBytes,
    collection: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join('/') }),
    doc: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join('/') }),
    setDoc: vi.fn(async (ref: Ref, data: Record<string, unknown>) => void docs.set(ref.path, { ...data })),
    deleteDoc: vi.fn(async (ref: Ref) => void docs.delete(ref.path)),
    getDocFromServer: async (ref: Ref) => ({ data: () => docs.get(ref.path) }),
    getDocsFromServer: async (collection: Ref) => ({
      docs: [...docs]
        .filter(([path]) => path.startsWith(`${collection.path}/`) && !path.slice(collection.path.length + 1).includes('/'))
        .map(([path, data]) => ({ id: path.split('/').at(-1)!, data: () => data })),
    }),
  };
  const songs = createFirestoreSongs(sdk as unknown as FirestoreSdk, {} as Firestore, 'u1');
  return { docs, sdk, songs };
}

const sound = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
};
/** (Not `toEqual`: that walks a megabyte of numbers one by one, which is slow enough to time out on a busy machine.) */
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const blobOf = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes], { type: 'audio/mpeg' });
const chart = fakeChart('a', { savedAt: 500, audio: 'a-1.mp3' });

afterEach(() => vi.useRealTimers());

describe('songs in Firestore', () => {
  it('keeps the audio in pieces that fit a document, beside the song', async () => {
    const { docs, songs } = fakeFirestore();
    const bytes = sound(2 * PART_BYTES + 1234);

    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(bytes));
    await songs.putSong(chart, audio);

    expect(audio).toEqual({ name: 'a-1.mp3', type: 'audio/mpeg', size: bytes.length, parts: 3 });
    expect([...docs.keys()].sort()).toEqual([
      'users/u1/songs/a',
      'users/u1/songs/a/parts/a-1.mp3-0',
      'users/u1/songs/a/parts/a-1.mp3-1',
      'users/u1/songs/a/parts/a-1.mp3-2',
    ]);
  });

  it('lists the songs, not their pieces, and reads back what was put', async () => {
    const { songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(PART_BYTES + 5)));
    await songs.putSong(chart, audio);

    const found = await songs.list();

    expect(found).toEqual([{ id: 'a', savedAt: 500, deleted: false, chart, audio }]);
  });

  it('gets the same audio back, piece by piece, reporting how far it has got', async () => {
    const { songs } = fakeFirestore();
    const bytes = sound(2 * PART_BYTES + 99);
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(bytes));
    const progress: number[] = [];

    const back = await songs.getAudio('a', audio, { progress: (fraction) => progress.push(fraction) });

    expect(back.type).toBe('audio/mpeg');
    expect(same(new Uint8Array(await back.arrayBuffer()), bytes)).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('sends a song with no sound as one empty piece, so it can be told apart from one that is missing', async () => {
    const { songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', new Blob([]));
    expect(audio).toMatchObject({ size: 0, parts: 1, type: 'application/octet-stream' });
    expect((await songs.getAudio('a', audio)).size).toBe(0);
  });

  it('leaves out a song whose document it cannot make sense of', async () => {
    const { docs, songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(10)));
    await songs.putSong(chart, audio);
    docs.set('users/u1/songs/bad-json', { savedAt: 1, deleted: false, json: '{nope', audioName: 'x', audioType: 't', audioSize: 1, audioParts: 1 });
    docs.set('users/u1/songs/wrong-id', { ...docs.get('users/u1/songs/a')! });
    docs.set('users/u1/songs/no-time', { deleted: false });
    docs.set('users/u1/songs/junk', 'not a record' as unknown as Record<string, unknown>);

    expect((await songs.list()).map((song) => song.id)).toEqual(['a']);
  });

  it('marks a removal with a note first, then clears the audio away', async () => {
    const { docs, sdk, songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(PART_BYTES + 1)));
    await songs.putSong(chart, audio);
    sdk.setDoc.mockClear();

    await songs.remove('a', 900, audio);

    expect(sdk.setDoc).toHaveBeenCalledTimes(1);
    expect([...docs.keys()]).toEqual(['users/u1/songs/a']);
    expect(await songs.list()).toEqual([{ id: 'a', savedAt: 900, deleted: true, chart: null, audio: null }]);
  });

  it('still counts a song as removed when its pieces will not go', async () => {
    const { sdk, songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(10)));
    await songs.putSong(chart, audio);
    sdk.deleteDoc.mockRejectedValue(new Error('offline'));

    await expect(songs.remove('a', 900, audio)).resolves.toBeUndefined();
    expect((await songs.list())[0]).toMatchObject({ deleted: true, savedAt: 900 });
  });

  it('drops only the audio it is told to, leaving another version alone', async () => {
    const { docs, songs } = fakeFirestore();
    const old = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(PART_BYTES + 1)));
    await songs.putAudio('a', 'a-2.mp3', blobOf(sound(10)));

    await songs.dropAudio('a', old);

    expect([...docs.keys()]).toEqual(['users/u1/songs/a/parts/a-2.mp3-0']);
  });

  it('says when a piece is missing or the song comes back the wrong size', async () => {
    const { docs, songs } = fakeFirestore();
    const audio = await songs.putAudio('a', 'a-1.mp3', blobOf(sound(2 * PART_BYTES)));

    docs.delete('users/u1/songs/a/parts/a-1.mp3-1');
    await expect(songs.getAudio('a', audio)).rejects.toBeInstanceOf(CloudError);

    docs.set('users/u1/songs/a/parts/a-1.mp3-1', { data: FakeBytes.fromUint8Array(sound(5)) });
    await expect(songs.getAudio('a', audio)).rejects.toThrow(/incomplete/);
  });

  it('takes a write that is never answered for a lost connection', async () => {
    vi.useFakeTimers();
    const { sdk, songs } = fakeFirestore();
    sdk.setDoc.mockImplementation(() => new Promise(() => undefined));

    const attempt = songs.putSong(chart, { name: 'a-1.mp3', type: 'audio/mpeg', size: 1, parts: 1 });
    const outcome = expect(attempt).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
  });

  it('stops starting pieces once one has failed', async () => {
    const { sdk, songs } = fakeFirestore();
    sdk.setDoc.mockImplementation(async (ref: Ref) => {
      if (ref.path.endsWith('-1')) throw Object.assign(new Error('no'), { code: 'permission-denied' });
    });

    await expect(songs.putAudio('a', 'a-1.mp3', blobOf(sound(6 * PART_BYTES)))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(sdk.setDoc.mock.calls.length).toBeLessThan(6); // (pieces already on their way finish; the rest are never started)
  });

  it('sends nothing when it is stopped first', async () => {
    const { sdk, songs } = fakeFirestore();
    const stop = new AbortController();
    stop.abort();

    await expect(songs.putAudio('a', 'a-1.mp3', blobOf(sound(10)), { signal: stop.signal })).rejects.toBeInstanceOf(Cancelled);
    expect(sdk.setDoc).not.toHaveBeenCalled();
  });
});
