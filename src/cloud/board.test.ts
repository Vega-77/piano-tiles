// @vitest-environment node
import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import type { FirestoreSdk } from './catalog';
import { createFirestorePlayers, createFirestoreScores } from './board';
import { CloudError } from './errors';

interface Ref {
  path: string;
}
type Constraint =
  | { kind: 'orderBy'; field: string; direction: 'asc' | 'desc' }
  | { kind: 'limit'; count: number }
  | { kind: 'where'; field: string; op: string; value: number };
interface Query extends Ref {
  constraints: Constraint[];
}

const STAMP = { serverTime: true };

/** The few Firestore calls the leaderboards and names make, over a map of paths to documents. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const children = (collection: string) =>
    [...docs].filter(([path]) => path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes('/'));
  const matching = (query: Query) => {
    let found = children(query.path);
    for (const constraint of query.constraints) {
      if (constraint.kind === 'where') {
        found = found.filter(([, data]) => (data[constraint.field] as number) > constraint.value);
      } else if (constraint.kind === 'orderBy') {
        found = [...found].sort(([, a], [, b]) => (b[constraint.field] as number) - (a[constraint.field] as number));
      } else {
        found = found.slice(0, constraint.count);
      }
    }
    return found;
  };

  const batches: Array<() => Promise<void>> = [];
  const sdk = {
    collection: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join('/') }),
    doc: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join('/') }),
    query: (ref: Ref, ...constraints: Constraint[]): Query => ({ ...ref, constraints }),
    orderBy: (field: string, direction: 'asc' | 'desc'): Constraint => ({ kind: 'orderBy', field, direction }),
    limit: (count: number): Constraint => ({ kind: 'limit', count }),
    where: (field: string, op: string, value: number): Constraint => ({ kind: 'where', field, op, value }),
    serverTimestamp: () => STAMP,
    setDoc: vi.fn(async (ref: Ref, data: Record<string, unknown>) => void docs.set(ref.path, { ...data })),
    getDocFromServer: async (ref: Ref) => ({ data: () => docs.get(ref.path), exists: () => docs.has(ref.path) }),
    getDocsFromServer: async (query: Query) => ({ docs: matching(query).map(([path, data]) => ({ id: path.split('/').at(-1)!, data: () => data })) }),
    getCountFromServer: async (query: Query) => ({ data: () => ({ count: matching(query).length }) }),
    commit: vi.fn(async (): Promise<void> => undefined),
    writeBatch: () => {
      const writes: Array<[string, Record<string, unknown>]> = [];
      return {
        set: (ref: Ref, data: Record<string, unknown>) => void writes.push([ref.path, data]),
        commit: async () => {
          await sdk.commit();
          for (const [path, data] of writes) docs.set(path, { ...data });
        },
      };
    },
  };
  void batches;
  const db = {} as Firestore;
  const use = sdk as unknown as FirestoreSdk;
  return { docs, sdk, scores: createFirestoreScores(use, db), players: createFirestorePlayers(use, db) };
}

const entry = (name: string, score: number, laps = 1, chain = 5) => ({ name, score, laps, chain, at: 1 });

describe('the leaderboards in Firestore', () => {
  it('lists the best entries first, at most as many as asked for', async () => {
    const { docs, scores } = fakeFirestore();
    docs.set('songs/a/scores/u1', entry('Ann', 300));
    docs.set('songs/a/scores/u2', entry('Bob', 900));
    docs.set('songs/a/scores/u3', entry('Cy', 600));
    docs.set('songs/b/scores/u4', entry('Di', 5000));

    const top = await scores.top('a', 2);

    expect(top).toEqual([
      { uid: 'u2', name: 'Bob', score: 900, laps: 1, chain: 5 },
      { uid: 'u3', name: 'Cy', score: 600, laps: 1, chain: 5 },
    ]);
  });

  it('leaves out an entry it cannot make sense of', async () => {
    const { docs, scores } = fakeFirestore();
    docs.set('songs/a/scores/u1', entry('Ann', 300));
    docs.set('songs/a/scores/u2', { name: 'Bob', score: 'lots' });

    expect((await scores.top('a', 10)).map((score) => score.uid)).toEqual(['u1']);
  });

  it('says where a player stands: one place behind each better entry', async () => {
    const { docs, scores } = fakeFirestore();
    docs.set('songs/a/scores/u1', entry('Ann', 300));
    docs.set('songs/a/scores/u2', entry('Bob', 900));
    docs.set('songs/a/scores/u3', entry('Cy', 600));
    docs.set('songs/a/scores/u4', entry('Di', 600));

    expect(await scores.standing('a', 'u2')).toMatchObject({ rank: 1, score: { name: 'Bob', score: 900 } });
    expect(await scores.standing('a', 'u3')).toMatchObject({ rank: 2 });
    expect(await scores.standing('a', 'u4')).toMatchObject({ rank: 2 }); // (a tie is not behind itself)
    expect(await scores.standing('a', 'u1')).toMatchObject({ rank: 4 });
  });

  it('has no standing for a player who has not played the song', async () => {
    const { docs, scores } = fakeFirestore();
    docs.set('songs/a/scores/u1', entry('Ann', 300));
    expect(await scores.standing('a', 'u9')).toBeUndefined();
    expect(await scores.standing('b', 'u1')).toBeUndefined();
  });

  it('puts a first run on the board, stamped by the server', async () => {
    const { docs, sdk, scores } = fakeFirestore();

    expect(await scores.submit('a', { uid: 'u1', name: 'Ann', score: 300, laps: 2, chain: 9 })).toBe(true);

    expect(sdk.setDoc).toHaveBeenCalledTimes(1);
    expect(docs.get('songs/a/scores/u1')).toEqual({ name: 'Ann', score: 300, laps: 2, chain: 9, at: STAMP });
  });

  it('only replaces an entry with a better one', async () => {
    const { docs, sdk, scores } = fakeFirestore();
    docs.set('songs/a/scores/u1', entry('Ann', 300));

    expect(await scores.submit('a', { uid: 'u1', name: 'Ann', score: 200, laps: 1, chain: 1 })).toBe(false);
    expect(await scores.submit('a', { uid: 'u1', name: 'Ann', score: 300, laps: 1, chain: 1 })).toBe(false);
    expect(sdk.setDoc).not.toHaveBeenCalled();

    expect(await scores.submit('a', { uid: 'u1', name: 'Ann', score: 301, laps: 3, chain: 12 })).toBe(true);
    expect(docs.get('songs/a/scores/u1')).toMatchObject({ score: 301, laps: 3, chain: 12 });
  });
});

describe('the names in Firestore', () => {
  it('reads the name an account has, or none', async () => {
    const { docs, players } = fakeFirestore();
    docs.set('players/u1', { name: 'Pat', key: 'pat' });
    docs.set('players/u2', { key: 'oops' });

    expect(await players.name('u1')).toBe('Pat');
    expect(await players.name('u2')).toBeNull();
    expect(await players.name('u3')).toBeNull();
  });

  it('knows an admin by the document made for them', async () => {
    const { docs, players } = fakeFirestore();
    docs.set('admins/u1', {});
    expect(await players.isAdmin('u1')).toBe(true);
    expect(await players.isAdmin('u2')).toBe(false);
  });

  it('takes a name by writing the name (in lower case) and the account together', async () => {
    const { docs, players } = fakeFirestore();

    await players.claim('u1', 'PatTy');

    expect(docs.get('names/patty')).toEqual({ uid: 'u1' });
    expect(docs.get('players/u1')).toEqual({ name: 'PatTy', key: 'patty' });
  });

  it('refuses a name that is taken, whatever its capitals', async () => {
    const { docs, sdk, players } = fakeFirestore();
    await players.claim('u1', 'Pat');

    await expect(players.claim('u2', 'PAT')).rejects.toBeInstanceOf(CloudError);
    await expect(players.claim('u2', 'PAT')).rejects.toThrow(/taken/);
    expect(sdk.commit).toHaveBeenCalledTimes(1);
    expect(docs.has('players/u2')).toBe(false);
  });

  it('is content when the name is already the account’s', async () => {
    const { sdk, players } = fakeFirestore();
    await players.claim('u1', 'Pat');
    await expect(players.claim('u1', 'Pat')).resolves.toBeUndefined();
    expect(sdk.commit).toHaveBeenCalledTimes(1);
  });

  it('says so when the rules turn a name away because somebody took it a moment ago', async () => {
    const { docs, sdk, players } = fakeFirestore();
    sdk.commit.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }));

    await expect(players.claim('u1', 'Pat')).rejects.toBeInstanceOf(CloudError);
    expect(docs.size).toBe(0);
  });

  it('lets any other failure through to be put into words elsewhere', async () => {
    const { sdk, players } = fakeFirestore();
    sdk.commit.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }));
    await expect(players.claim('u1', 'Pat')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
