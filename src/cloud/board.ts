import type { Firestore } from 'firebase/firestore';
import { withTimeout, type FirestoreSdk } from './catalog';
import { CloudError } from './errors';
import { nameKey } from './names';
import type { Players, Score, Scores } from './types';

/** How many entries are removed in one write (a batch may hold 500). */
const CLEAR_BATCH = 400;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** An entry from its document, or undefined for one this version can't make sense of. */
function readScore(uid: string, data: unknown): Score | undefined {
  if (!isRecord(data)) return undefined;
  const { name, score, laps, chain } = data;
  if (typeof name !== 'string' || typeof score !== 'number' || typeof laps !== 'number' || typeof chain !== 'number') return undefined;
  return { uid, name, score, laps, chain };
}

/**
 * The leaderboards in Firestore: one entry per player under `songs/<song id>/scores/<uid>`. The
 * rules (firestore.rules) let anyone read them and a player write only their own entry, under the
 * name they have taken, and only to raise it.
 */
export function createFirestoreScores(sdk: FirestoreSdk, db: Firestore): Scores {
  const board = (songId: string) => sdk.collection(db, 'songs', songId, 'scores');
  const entry = (songId: string, uid: string) => sdk.doc(db, 'songs', songId, 'scores', uid);

  return {
    async top(songId, count) {
      const snapshot = await sdk.getDocsFromServer(sdk.query(board(songId), sdk.orderBy('score', 'desc'), sdk.limit(count)));
      const found: Score[] = [];
      for (const document of snapshot.docs) {
        const score = readScore(document.id, document.data());
        if (score) found.push(score);
      }
      return found;
    },

    async standing(songId, uid) {
      const own = readScore(uid, (await sdk.getDocFromServer(entry(songId, uid))).data());
      if (!own) return undefined;
      // (Counted on the server rather than read: it is one read per thousand entries, however many there are.)
      const ahead = await sdk.getCountFromServer(sdk.query(board(songId), sdk.where('score', '>', own.score)));
      return { score: own, rank: ahead.data().count + 1 };
    },

    async submit(songId, run) {
      const before = readScore(run.uid, (await sdk.getDocFromServer(entry(songId, run.uid))).data());
      if (before && before.score >= run.score) return false;
      await withTimeout(
        sdk.setDoc(entry(songId, run.uid), { name: run.name, score: run.score, laps: run.laps, chain: run.chain, at: sdk.serverTimestamp() }),
      );
      return true;
    },

    async clear(songId) {
      const snapshot = await sdk.getDocsFromServer(sdk.query(board(songId)));
      const ids = snapshot.docs.map((document) => document.id);
      for (let from = 0; from < ids.length; from += CLEAR_BATCH) {
        const batch = sdk.writeBatch(db);
        for (const id of ids.slice(from, from + CLEAR_BATCH)) batch.delete(entry(songId, id));
        await withTimeout(batch.commit());
      }
      return ids.length;
    },
  };
}

/**
 * The names in Firestore. A name is taken by writing two documents together: `names/<name in
 * lower case>`, which can only ever be created (so a name has one owner), and `players/<uid>`,
 * which says which name an account has. The rules check that the two agree.
 */
export function createFirestorePlayers(sdk: FirestoreSdk, db: Firestore): Players {
  return {
    async name(uid) {
      const data = (await sdk.getDocFromServer(sdk.doc(db, 'players', uid))).data();
      return isRecord(data) && typeof data.name === 'string' ? data.name : null;
    },

    async isAdmin(uid) {
      return (await sdk.getDocFromServer(sdk.doc(db, 'admins', uid))).exists();
    },

    async claim(uid, name) {
      const key = nameKey(name);
      const taken = await sdk.getDocFromServer(sdk.doc(db, 'names', key));
      if (taken.exists()) {
        if (taken.data()?.uid === uid) return; // (already theirs)
        throw new CloudError(`“${name}” is taken. Try another name.`);
      }
      const batch = sdk.writeBatch(db);
      batch.set(sdk.doc(db, 'names', key), { uid });
      batch.set(sdk.doc(db, 'players', uid), { name, key });
      try {
        await withTimeout(batch.commit());
      } catch (error) {
        // (The rules turn away a name that somebody took a moment ago, and that is the way this can fail that the player can do something about.)
        if ((error as { code?: unknown } | null)?.code === 'permission-denied') {
          throw new CloudError(`“${name}” was just taken, or can't be used. Try another name.`);
        }
        throw error;
      }
    },
  };
}
