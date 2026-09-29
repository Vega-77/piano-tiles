/** Little fakes for the tests of the cloud code (nothing here is used by the app). */
import type { ChartFile } from '../songs/chart';
import type { CloudAccount, CloudBackend, CloudSongs, RemoteAudio, RemoteSong } from './types';

/** A cloud kept in memory. `calls` says what was asked of it, in order, and `offline` makes every call fail like a lost connection. */
export interface MemoryCloud extends CloudSongs {
  calls: string[];
  offline: boolean;
  /** What is stored, to look at (the audio by song id and name). */
  songs: Map<string, RemoteSong>;
  audio: Map<string, Blob>;
}

/** What the SDK throws when there is no connection. */
const lost = () => Object.assign(new Error('The cloud cannot be reached.'), { code: 'unavailable' });

export function createMemoryCloud(): MemoryCloud {
  const cloud: MemoryCloud = {
    calls: [],
    offline: false,
    songs: new Map(),
    audio: new Map(),

    async list() {
      cloud.calls.push('list');
      if (cloud.offline) throw lost();
      return [...cloud.songs.values()].map((song) => structuredClone(song));
    },
    async putAudio(id, name, audio) {
      cloud.calls.push(`putAudio ${id}`);
      if (cloud.offline) throw lost();
      cloud.audio.set(`${id}|${name}`, audio);
      return { name, type: audio.type, size: audio.size, parts: Math.max(1, Math.ceil(audio.size / 900_000)) };
    },
    async putSong(chart: ChartFile, audio: RemoteAudio) {
      cloud.calls.push(`putSong ${chart.id}`);
      if (cloud.offline) throw lost();
      if (!cloud.audio.has(`${chart.id}|${audio.name}`)) throw new Error(`a song was put without its audio: ${chart.id}`);
      cloud.songs.set(chart.id, { id: chart.id, savedAt: chart.savedAt ?? 0, deleted: false, chart: structuredClone(chart), audio });
    },
    async dropAudio(id, audio) {
      cloud.calls.push(`dropAudio ${id}`);
      cloud.audio.delete(`${id}|${audio.name}`);
    },
    async getAudio(id, audio) {
      cloud.calls.push(`getAudio ${id}`);
      if (cloud.offline) throw lost();
      const blob = cloud.audio.get(`${id}|${audio.name}`);
      if (!blob) throw new Error(`no audio for ${id}`);
      return blob;
    },
    async remove(id, removedAt, audio) {
      cloud.calls.push(`remove ${id}`);
      if (cloud.offline) throw lost();
      cloud.songs.set(id, { id, savedAt: removedAt, deleted: true, chart: null, audio: null });
      if (audio) cloud.audio.delete(`${id}|${audio.name}`);
    },
  };
  return cloud;
}

/** A backend with nobody signed in until `signIn`, and one cloud per account. */
export interface FakeBackend extends CloudBackend {
  account: CloudAccount | null;
  clouds: Map<string, MemoryCloud>;
  warmed: number;
  /** Makes the next `signIn` fail with this. */
  failSignIn?: unknown;
}

export function createFakeBackend(person: CloudAccount = { uid: 'u1', name: 'Pat' }): FakeBackend {
  const listeners = new Set<(account: CloudAccount | null) => void>();
  const say = () => listeners.forEach((listener) => listener(backend.account));
  const backend: FakeBackend = {
    account: null,
    clouds: new Map(),
    warmed: 0,
    warmUp: () => void backend.warmed++,
    watch(listener) {
      listeners.add(listener);
      queueMicrotask(() => listener(backend.account));
      return () => void listeners.delete(listener);
    },
    async signIn() {
      if (backend.failSignIn) {
        const failure = backend.failSignIn;
        backend.failSignIn = undefined;
        throw failure;
      }
      backend.account = person;
      say();
    },
    async signOut() {
      backend.account = null;
      say();
    },
    async songs(account) {
      let cloud = backend.clouds.get(account.uid);
      if (!cloud) backend.clouds.set(account.uid, (cloud = createMemoryCloud()));
      return cloud;
    },
  };
  return backend;
}
