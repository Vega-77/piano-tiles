import type { Firestore } from 'firebase/firestore';
import { validateChart } from '../songs/chart';
import { Cancelled } from '../songs/errors';
import { CloudError } from './errors';
import type { CloudSongs, RemoteAudio, RemoteSong, Transfer } from './types';

/** The parts of the Firestore SDK used here. It is loaded when it is first needed, so it is handed in. */
export type FirestoreSdk = typeof import('firebase/firestore');

/**
 * How many bytes of a song go in one document. A document can be at most 1 MiB, and there is room
 * to spare for the little else that is in one. (Firebase's file storage would do this without
 * cutting the song up, but it needs a paid plan; the database is free.)
 */
export const PART_BYTES = 900_000;

/** How many pieces are on their way at once. */
const PARALLEL = 3;

/** A write that hasn't been answered by then is taken to be a lost connection. (A write waits for the server, so offline it would wait for ever.) */
const WRITE_TIMEOUT_MS = 60_000;

const partId = (audioName: string, n: number) => `${audioName}-${n}`;

/** Runs `job(0)`, `job(1)`... up to `count - 1`, a few at a time, stopping at the first to fail. */
async function inParallel(count: number, job: (n: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < count && !failed) {
      if (signal?.aborted) throw new Cancelled();
      try {
        await job(next++);
      } catch (error) {
        failed = true; // (the others finish the piece they are on, and take no more)
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('The cloud did not answer.'), { code: 'unavailable' })), WRITE_TIMEOUT_MS);
  });
  return Promise.race([work, lost]).finally(() => clearTimeout(timer));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A song from its document, or undefined for one this version can't make sense of (it is left alone, not synced). */
function readSong(id: string, data: unknown): RemoteSong | undefined {
  if (!isRecord(data) || typeof data.savedAt !== 'number') return undefined;
  if (data.deleted === true) return { id, savedAt: data.savedAt, deleted: true, chart: null, audio: null };
  try {
    if (typeof data.json !== 'string') return undefined;
    const chart = validateChart(JSON.parse(data.json));
    if (chart.id !== id) return undefined;
    const { audioName, audioType, audioSize, audioParts } = data;
    if (typeof audioName !== 'string' || typeof audioType !== 'string') return undefined;
    if (typeof audioSize !== 'number' || typeof audioParts !== 'number') return undefined;
    return { id, savedAt: data.savedAt, deleted: false, chart, audio: { name: audioName, type: audioType, size: audioSize, parts: audioParts } };
  } catch {
    return undefined;
  }
}

/**
 * The account's songs in Firestore, under `users/<uid>/songs/<song id>`: one document per song
 * with its chart and where its audio is, and the audio in pieces beside it, in `parts`. The rules
 * (firestore.rules) let an account reach only what is under its own uid.
 */
export function createFirestoreSongs(sdk: FirestoreSdk, db: Firestore, uid: string): CloudSongs {
  const songs = () => sdk.collection(db, 'users', uid, 'songs');
  const songRef = (id: string) => sdk.doc(db, 'users', uid, 'songs', id);
  const partRef = (id: string, audioName: string, n: number) => sdk.doc(db, 'users', uid, 'songs', id, 'parts', partId(audioName, n));

  return {
    async list() {
      // (From the server, so nothing is mistaken for the state of the cloud when it is really an old copy.)
      const snapshot = await sdk.getDocsFromServer(songs());
      const found: RemoteSong[] = [];
      for (const document of snapshot.docs) {
        const song = readSong(document.id, document.data());
        if (song) found.push(song);
      }
      return found;
    },

    async putAudio(id, name, audio, { progress, signal }: Transfer = {}): Promise<RemoteAudio> {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const parts = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
      let done = 0;
      progress?.(0);
      await inParallel(
        parts,
        async (n) => {
          const piece = bytes.subarray(n * PART_BYTES, (n + 1) * PART_BYTES);
          await withTimeout(sdk.setDoc(partRef(id, name, n), { data: sdk.Bytes.fromUint8Array(piece) }));
          progress?.(++done / parts);
        },
        signal,
      );
      return { name, type: audio.type || 'application/octet-stream', size: bytes.length, parts };
    },

    async putSong(chart, audio) {
      await withTimeout(
        sdk.setDoc(songRef(chart.id), {
          savedAt: chart.savedAt ?? 0,
          deleted: false,
          json: JSON.stringify(chart),
          audioName: audio.name,
          audioType: audio.type,
          audioSize: audio.size,
          audioParts: audio.parts,
        }),
      );
    },

    async dropAudio(id, audio) {
      await inParallel(audio.parts, (n) => withTimeout(sdk.deleteDoc(partRef(id, audio.name, n))));
    },

    async getAudio(id, audio, { progress, signal }: Transfer = {}) {
      const pieces: Uint8Array<ArrayBuffer>[] = new Array(audio.parts);
      let done = 0;
      progress?.(0);
      await inParallel(
        audio.parts,
        async (n) => {
          const part = await sdk.getDocFromServer(partRef(id, audio.name, n));
          const data: unknown = part.data()?.data;
          if (!(data instanceof sdk.Bytes)) throw new CloudError('A song in the cloud is missing a piece. Send it again from the device that has it.');
          pieces[n] = data.toUint8Array() as Uint8Array<ArrayBuffer>;
          progress?.(++done / audio.parts);
        },
        signal,
      );
      const blob = new Blob(pieces, { type: audio.type });
      if (blob.size !== audio.size) throw new CloudError('A song in the cloud is incomplete. Send it again from the device that has it.');
      return blob;
    },

    async remove(id, removedAt, audio) {
      // The note first: if the pieces are then slow to go, the other devices already know the song is gone.
      await withTimeout(sdk.setDoc(songRef(id), { savedAt: removedAt, deleted: true }));
      if (audio) await inParallel(audio.parts, (n) => withTimeout(sdk.deleteDoc(partRef(id, audio.name, n)))).catch(() => undefined);
    },
  };
}
