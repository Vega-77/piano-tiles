/** Little fakes for the tests of the cloud code (nothing here is used by the app). */
import type { ChartFile } from '../songs/chart';
import { CloudError } from './errors';
import { nameKey } from './names';
import type { Catalog, CloudAccount, CloudBackend, Players, RemoteAudio, RemoteSong, Run, Score, Scores } from './types';

/** What the SDK throws when there is no connection. */
const lost = () => Object.assign(new Error('The cloud cannot be reached.'), { code: 'unavailable' });

/** A catalogue kept in memory. `calls` says what was asked of it, in order, and `offline` makes every call fail like a lost connection. */
export interface MemoryCatalog extends Catalog {
  calls: string[];
  offline: boolean;
  /** What is stored, to look at (the audio by song id and name). */
  songs: Map<string, RemoteSong>;
  audio: Map<string, Blob>;
}

export function createMemoryCatalog(): MemoryCatalog {
  const catalog: MemoryCatalog = {
    calls: [],
    offline: false,
    songs: new Map(),
    audio: new Map(),

    async list() {
      catalog.calls.push('list');
      if (catalog.offline) throw lost();
      return [...catalog.songs.values()].map((song) => structuredClone(song));
    },
    async putAudio(id, name, audio) {
      catalog.calls.push(`putAudio ${id}`);
      if (catalog.offline) throw lost();
      catalog.audio.set(`${id}|${name}`, audio);
      return { name, type: audio.type, size: audio.size, parts: Math.max(1, Math.ceil(audio.size / 900_000)) };
    },
    async putSong(chart: ChartFile, audio: RemoteAudio) {
      catalog.calls.push(`putSong ${chart.id}`);
      if (catalog.offline) throw lost();
      if (!catalog.audio.has(`${chart.id}|${audio.name}`)) throw new Error(`a song was put without its audio: ${chart.id}`);
      catalog.songs.set(chart.id, { id: chart.id, savedAt: chart.savedAt ?? 0, chart: structuredClone(chart), audio });
    },
    async getAudio(id, audio) {
      catalog.calls.push(`getAudio ${id}`);
      if (catalog.offline) throw lost();
      const blob = catalog.audio.get(`${id}|${audio.name}`);
      if (!blob) throw new Error(`no audio for ${id}`);
      return blob;
    },
    async remove(id, audio) {
      catalog.calls.push(`remove ${id}`);
      if (catalog.offline) throw lost();
      catalog.songs.delete(id);
      catalog.audio.delete(`${id}|${audio.name}`);
    },
  };
  return catalog;
}

/** Leaderboards kept in memory: `boards` maps a song id to its entries by account. */
export interface MemoryScores extends Scores {
  calls: string[];
  offline: boolean;
  boards: Map<string, Map<string, Score>>;
}

export function createMemoryScores(): MemoryScores {
  const scores: MemoryScores = {
    calls: [],
    offline: false,
    boards: new Map(),

    async top(songId, count) {
      scores.calls.push(`top ${songId}`);
      if (scores.offline) throw lost();
      return [...(scores.boards.get(songId)?.values() ?? [])].sort((a, b) => b.score - a.score).slice(0, count);
    },
    async standing(songId, uid) {
      scores.calls.push(`standing ${songId}`);
      if (scores.offline) throw lost();
      const board = scores.boards.get(songId);
      const own = board?.get(uid);
      if (!board || !own) return undefined;
      return { score: own, rank: 1 + [...board.values()].filter((other) => other.score > own.score).length };
    },
    async submit(songId, run: Run) {
      scores.calls.push(`submit ${songId} ${run.score}`);
      if (scores.offline) throw lost();
      const board = scores.boards.get(songId) ?? new Map<string, Score>();
      scores.boards.set(songId, board);
      if ((board.get(run.uid)?.score ?? 0) >= run.score) return false;
      board.set(run.uid, { ...run });
      return true;
    },
    async clear(songId) {
      scores.calls.push(`clear ${songId}`);
      if (scores.offline) throw lost();
      const removed = scores.boards.get(songId)?.size ?? 0;
      scores.boards.delete(songId);
      return removed;
    },
  };
  return scores;
}

/** Names and admins kept in memory. */
export interface MemoryPlayers extends Players {
  calls: string[];
  offline: boolean;
  /** Which account each name (in lower case) belongs to, and the name each account has. */
  owners: Map<string, string>;
  names: Map<string, string>;
  admins: Set<string>;
}

export function createMemoryPlayers(): MemoryPlayers {
  const players: MemoryPlayers = {
    calls: [],
    offline: false,
    owners: new Map(),
    names: new Map(),
    admins: new Set(),

    async name(uid) {
      players.calls.push(`name ${uid}`);
      if (players.offline) throw lost();
      return players.names.get(uid) ?? null;
    },
    async isAdmin(uid) {
      players.calls.push(`isAdmin ${uid}`);
      if (players.offline) throw lost();
      return players.admins.has(uid);
    },
    async claim(uid, name) {
      players.calls.push(`claim ${name}`);
      if (players.offline) throw lost();
      const owner = players.owners.get(nameKey(name));
      if (owner !== undefined && owner !== uid) throw new CloudError(`“${name}” is taken. Try another name.`);
      if (players.names.has(uid) && players.names.get(uid) !== name) throw new CloudError('This account has a name already.');
      players.owners.set(nameKey(name), uid);
      players.names.set(uid, name);
    },
  };
  return players;
}

/** A backend with nobody signed in until a sign-in, and one of each service, shared by everyone. */
export interface FakeBackend extends CloudBackend {
  account: CloudAccount | null;
  catalogue: MemoryCatalog;
  leaderboards: MemoryScores;
  people: MemoryPlayers;
  warmed: number;
  guests: number;
  /** Who a Google sign-in signs in as. */
  google: CloudAccount;
  /** Makes the next sign-in fail with this. */
  failSignIn?: unknown;
}

export function createFakeBackend(google: CloudAccount = { uid: 'g1', name: 'Pat', guest: false }): FakeBackend {
  const listeners = new Set<(account: CloudAccount | null) => void>();
  const say = () => listeners.forEach((listener) => listener(backend.account));
  const check = () => {
    if (backend.failSignIn) {
      const failure = backend.failSignIn;
      backend.failSignIn = undefined;
      throw failure;
    }
  };
  const backend: FakeBackend = {
    account: null,
    catalogue: createMemoryCatalog(),
    leaderboards: createMemoryScores(),
    people: createMemoryPlayers(),
    warmed: 0,
    guests: 0,
    google,

    warmUp: () => void backend.warmed++,
    watch(listener) {
      listeners.add(listener);
      queueMicrotask(() => listener(backend.account));
      return () => void listeners.delete(listener);
    },
    async signInAsGuest() {
      check();
      backend.account = { uid: `guest-${++backend.guests}`, name: 'Guest', guest: true };
      say();
      return backend.account;
    },
    async signInWithGoogle() {
      check();
      // (A guest who signs in with Google is upgraded: the account keeps its id.)
      backend.account = backend.account?.guest ? { ...backend.google, uid: backend.account.uid } : backend.google;
      say();
    },
    async signOut() {
      backend.account = null;
      say();
    },
    catalog: async () => backend.catalogue,
    scores: async () => backend.leaderboards,
    players: async () => backend.people,
  };
  return backend;
}
