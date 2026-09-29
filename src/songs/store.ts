import type { ChartFile } from './chart';
import { ImportError } from './errors';

/**
 * Where the songs a player adds are kept: in the browser on this device (IndexedDB), each as its
 * chart (a small piece of JSON) and its audio. Nothing is sent anywhere. To move a song to another
 * device, export it as a song file (see bundle.ts) and add that file on the other one.
 */
export interface SongStore {
  /** Whether songs put in here are still there after the page is closed (false if the browser wouldn't allow it). */
  readonly persistent: boolean;
  /** Every saved chart, as it was saved: the caller checks them. */
  charts(): Promise<unknown[]>;
  chart(id: string): Promise<unknown | undefined>;
  audio(id: string): Promise<Blob | undefined>;
  /** Saves a song. Leave out `audio` to change the chart and keep the audio that is already there. */
  save(chart: ChartFile, audio?: Blob): Promise<void>;
  remove(id: string): Promise<void>;
}

const NO_ROOM = 'There is no room left on this device for another song. Remove one you no longer play, then try again.';

/** Words for a failed write: running out of room is the one the player can do something about. */
export function friendly(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new ImportError(NO_ROOM);
  return new ImportError("Couldn't save the song in this browser. If this is a private window, songs can't be kept here.");
}

// ---- in memory --------------------------------------------------------------------------------

/** A store that lives only as long as the page: for tests, and for a browser that won't let the app keep songs. */
export function createMemoryStore(persistent = false): SongStore {
  const charts = new Map<string, string>();
  const audio = new Map<string, Blob>();
  return {
    persistent,
    charts: async () => [...charts.values()].map((text) => JSON.parse(text) as unknown),
    chart: async (id) => (charts.has(id) ? (JSON.parse(charts.get(id)!) as unknown) : undefined),
    audio: async (id) => audio.get(id),
    save: async (chart, blob) => {
      charts.set(chart.id, JSON.stringify(chart));
      if (blob) audio.set(chart.id, blob);
    },
    remove: async (id) => {
      charts.delete(id);
      audio.delete(id);
    },
  };
}

// ---- IndexedDB --------------------------------------------------------------------------------

const DATABASE = 'piano-tiles-songs';
const VERSION = 1;
// The audio is a store of its own so listing the songs never reads any of it.
const CHARTS = 'charts';
const AUDIO = 'audio';

const asPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new DOMException('The save was cancelled.', 'AbortError'));
  });

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(CHARTS);
      request.result.createObjectStore(AUDIO);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab wants to upgrade the database: let it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The song database is in use by an older copy of the page.'));
  });
}

/** Songs kept in IndexedDB. Rejects (from any method) if the browser won't open a database. */
export function createIndexedDbStore(factory: IDBFactory = indexedDB): SongStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => (opened ??= openDatabase(factory).catch((error) => {
    opened = undefined; // (a later try may work)
    throw error;
  }));

  const read = async <T>(store: string, run: (objects: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return asPromise(run(db.transaction(store, 'readonly').objectStore(store)));
  };

  return {
    persistent: true,
    charts: () => read(CHARTS, (store) => store.getAll()),
    chart: (id) => read(CHARTS, (store) => store.get(id)),
    audio: (id) => read<Blob | undefined>(AUDIO, (store) => store.get(id)),
    async save(chart, audio) {
      const db = await open();
      try {
        const transaction = db.transaction([CHARTS, AUDIO], 'readwrite');
        transaction.objectStore(CHARTS).put(chart, chart.id);
        if (audio) transaction.objectStore(AUDIO).put(audio, chart.id);
        await finished(transaction);
      } catch (error) {
        throw friendly(error);
      }
    },
    async remove(id) {
      const db = await open();
      const transaction = db.transaction([CHARTS, AUDIO], 'readwrite');
      transaction.objectStore(CHARTS).delete(id);
      transaction.objectStore(AUDIO).delete(id);
      await finished(transaction);
    },
  };
}

// ---- the one the app uses ---------------------------------------------------------------------

let shared: Promise<SongStore> | undefined;

/**
 * The store for this page. If the browser has no IndexedDB, or won't open one (a private window in
 * some browsers), songs still work for as long as the page is open, and `persistent` says so.
 */
export function getSongStore(): Promise<SongStore> {
  shared ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      const store = createIndexedDbStore();
      await store.charts(); // opens it, so a browser that refuses is found out now
      return store;
    } catch {
      return createMemoryStore(false);
    }
  })();
  return shared;
}

/** Asks the browser not to clear the songs to make room (it may say no, or ask the player). Best effort. */
export async function keepSongs(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Not fatal: the songs are stored either way.
  }
}

// ---- how the game finds a stored song's audio -------------------------------------------------

const STORED = /^stored:([a-z0-9][a-z0-9-]{0,63})\//;

/** Where a stored song's files live as far as the game is concerned: `stored:<id>/`. */
export const storedFolder = (id: string) => `stored:${id}/`;

/** The id in a `stored:` URL, or undefined for any other URL. */
export const storedId = (url: string): string | undefined => STORED.exec(url)?.[1];

export const MISSING_AUDIO =
  "This song's audio is no longer on this device. Remove the song and add it again, or add its song file.";

/**
 * The bytes of a stored song's audio, for `AudioEngine`: undefined if `url` isn't a stored song's,
 * so the engine fetches it like any other.
 */
export async function readStoredAudio(url: string, open: () => Promise<SongStore> = getSongStore): Promise<ArrayBuffer | undefined> {
  const id = storedId(url);
  if (id === undefined) return undefined;
  const blob = await (await open()).audio(id);
  if (!blob) throw new Error(MISSING_AUDIO);
  return blob.arrayBuffer();
}
