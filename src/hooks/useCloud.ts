import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudError, describeCloudError } from '../cloud/errors';
import { firebaseBackend } from '../cloud/firebase';
import { parseName } from '../cloud/names';
import type { CloudAccount, CloudBackend, Score, Standing } from '../cloud/types';

/** A song's leaderboard as it is shown: the best few, and where the player stands (if they have a place). */
export interface Board {
  top: Score[];
  mine?: Standing;
}

/** What a run brings to the board. */
export interface RunScore {
  score: number;
  laps: number;
  chain: number;
}

/** How many places are shown. */
export const BOARD_SIZE = 10;

/** A board looked at again within this long is not fetched again: each look costs a dozen reads of the free daily allowance. */
const FRESH_MS = 3 * 60_000;

export interface CloudOptions {
  backend?: CloudBackend;
}

/**
 * Who is playing: a guest with a nickname of their own, or a Google account. Nothing is asked of
 * anyone until they choose a nickname after a run (that is when a guest account is made), and
 * Firebase is loaded at once so the published songs are there, but nobody is signed in by it.
 */
export function useCloud({ backend = firebaseBackend }: CloudOptions = {}) {
  const [account, setAccount] = useState<CloudAccount | null>(null);
  /** The nickname: undefined while not known yet, null if there is none. */
  const [nickname, setNickname] = useState<string | null | undefined>(undefined);
  const [admin, setAdmin] = useState(false);
  /** Finding out who is signed in, which takes a moment after the page opens. */
  const [checking, setChecking] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef({ backend, account, nickname });
  latest.current = { backend, account, nickname };
  const boards = useRef(new Map<string, { at: number; board: Board }>());
  const stopWatching = useRef<(() => void) | null>(null);

  const watch = useCallback(() => {
    if (stopWatching.current) return;
    const stop = latest.current.backend.watch(
      (next) => {
        setAccount(next);
        setChecking(false);
      },
      (failure) => {
        // (Not shown: offline, the songs already here play all the same, and coming back online tries again.)
        console.error('Finding out who is signed in failed', failure);
        stop();
        if (stopWatching.current === stop) stopWatching.current = null;
        setChecking(false);
      },
    );
    stopWatching.current = stop;
  }, []);

  useEffect(() => {
    latest.current.backend.warmUp();
    watch();
    window.addEventListener('online', watch);
    return () => {
      window.removeEventListener('online', watch);
      stopWatching.current?.();
      stopWatching.current = null;
    };
  }, [watch]);

  // Whose nickname and boards these are changes with the account, not with a guest becoming a Google account (which keeps its id).
  const uid = account?.uid;
  const guest = account?.guest;
  useEffect(() => {
    boards.current.clear();
    if (uid === undefined) {
      setNickname(undefined);
      return;
    }
    let current = true;
    setNickname(undefined);
    latest.current.backend
      .players()
      .then((players) => players.name(uid))
      // (A name taken while this was being read stays: a guest is signed in a moment before their nickname is claimed.)
      .then((name) => current && setNickname((known) => known ?? name))
      .catch((failure) => console.error('Reading the nickname failed', failure));
    return () => {
      current = false;
    };
  }, [uid]);

  // Only a Google account can be an admin, and it is found out by asking (the rules decide, not this).
  useEffect(() => {
    setAdmin(false);
    if (uid === undefined || guest !== false) return;
    let current = true;
    latest.current.backend
      .players()
      .then((players) => players.isAdmin(uid))
      .then((is) => current && setAdmin(is))
      .catch((failure) => console.error('Checking for an admin failed', failure));
    return () => {
      current = false;
    };
  }, [uid, guest]);

  /** Takes a nickname for good. Resolves with what is wrong with it, or null once it is theirs. Signs in as a guest first if nobody is. */
  const claimName = useCallback(async (input: string): Promise<string | null> => {
    try {
      const name = parseName(input);
      const { backend, account } = latest.current;
      const who = account ?? (await backend.signInAsGuest());
      await (await backend.players()).claim(who.uid, name);
      setNickname(name);
      return null;
    } catch (failure) {
      if (!(failure instanceof CloudError)) console.error('Taking the nickname failed', failure);
      // (Whoever asked for a name has none yet, which is what the form is for; a guest made just now has not been read for one.)
      setNickname((known) => known ?? null);
      return describeCloudError(failure) ?? 'That name could not be taken.';
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      await latest.current.backend.signInWithGoogle();
    } catch (failure) {
      const words = describeCloudError(failure);
      if (words) {
        console.error('Signing in failed', failure);
        setError(words);
      }
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await latest.current.backend.signOut();
    } catch (failure) {
      setError(describeCloudError(failure) ?? null);
    }
  }, []);

  /** A song's leaderboard. Rejects if the cloud can't be reached. */
  const loadBoard = useCallback(async (songId: string, fresh = false): Promise<Board> => {
    const { backend, account } = latest.current;
    const key = `${account?.uid ?? ''}|${songId}`;
    const hit = boards.current.get(key);
    if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return hit.board;
    const scores = await backend.scores();
    const [top, mine] = await Promise.all([scores.top(songId, BOARD_SIZE), account ? scores.standing(songId, account.uid) : undefined]);
    const board: Board = { top, mine };
    boards.current.set(key, { at: Date.now(), board });
    return board;
  }, []);

  /**
   * Puts a finished run on a song's board (it only counts if it beats the player's best there) and
   * resolves with the board as it is now. Rejects if it can't be done, and the run can be sent again.
   */
  const submit = useCallback(
    async (songId: string, run: RunScore): Promise<Board & { improved: boolean }> => {
      const { backend, account, nickname } = latest.current;
      if (!account || !nickname) throw new CloudError('Choose a nickname first.');
      const scores = await backend.scores();
      const improved = await scores.submit(songId, {
        uid: account.uid,
        name: nickname,
        score: Math.round(run.score),
        laps: run.laps,
        chain: run.chain,
      });
      boards.current.clear();
      return { ...(await loadBoard(songId, true)), improved };
    },
    [loadBoard],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { account, nickname, admin, checking, signingIn, error, claimName, signInWithGoogle, signOut, loadBoard, submit, dismissError };
}

export type Cloud = ReturnType<typeof useCloud>;
