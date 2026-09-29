/**
 * The songs removed on this device, and when. Syncing needs it: a song that is gone here but still
 * in the cloud is either one to remove there too (it was removed here) or one that is new (it was
 * added on another device), and only a note of the removal tells the two apart.
 */
export interface RemovalLog {
  all(): ReadonlyMap<string, number>;
  add(id: string, at: number): void;
  drop(id: string): void;
}

/** The notes kept at most: old ones are let go first. Each is tiny; this is only so they can't pile up for ever. */
const MAX_NOTES = 200;

export function createMemoryRemovals(): RemovalLog {
  const notes = new Map<string, number>();
  return {
    all: () => new Map(notes),
    add: (id, at) => void notes.set(id, at),
    drop: (id) => void notes.delete(id),
  };
}

const KEY = 'piano-tiles-removed';

/** The log kept in this browser (localStorage), which quietly does nothing where that isn't allowed. */
export function createLocalRemovals(): RemovalLog {
  const read = (): Map<string, number> => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      if (!Array.isArray(parsed)) return new Map();
      const notes = new Map<string, number>();
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') notes.set(entry[0], entry[1]);
      }
      return notes;
    } catch {
      return new Map();
    }
  };
  const write = (notes: Map<string, number>) => {
    try {
      const newest = [...notes].sort((a, b) => b[1] - a[1]).slice(0, MAX_NOTES);
      localStorage.setItem(KEY, JSON.stringify(newest));
    } catch {
      // Not fatal: the song is removed here either way; it may come back from the cloud.
    }
  };
  return {
    all: read,
    add(id, at) {
      const notes = read();
      notes.set(id, at);
      write(notes);
    },
    drop(id) {
      const notes = read();
      if (notes.delete(id)) write(notes);
    },
  };
}

/** The log the app uses. */
export const removalLog: RemovalLog = createLocalRemovals();
