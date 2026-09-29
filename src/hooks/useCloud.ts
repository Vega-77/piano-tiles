import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCloudError } from '../cloud/errors';
import { firebaseBackend } from '../cloud/firebase';
import { removalLog, type RemovalLog } from '../cloud/removals';
import { runSync, type Skipped } from '../cloud/sync';
import type { CloudAccount, CloudBackend } from '../cloud/types';
import { Cancelled } from '../songs/errors';
import { getSongStore, type SongStore } from '../songs/store';

const REMEMBER = 'piano-tiles-cloud';

/** Whether this browser was signed in last time, which is when Firebase is worth loading before anyone asks for it. */
function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(REMEMBER) === '1';
  } catch {
    return false;
  }
}

function remember(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(REMEMBER, '1');
    else localStorage.removeItem(REMEMBER);
  } catch {
    // Not fatal: the next visit just waits to be asked to sign in.
  }
}

/** How long after the last change to wait before syncing, so a run of changes is one sync. */
const CHANGE_DELAY_MS = 1500;
/** Coming back to the page syncs again if the last one was longer ago than this (another device may have changed something). */
const RETURN_AFTER_MS = 60_000;

export interface CloudOptions {
  /** Reads the library again, once a sync has changed what is on this device. */
  refresh: () => Promise<void>;
  backend?: CloudBackend;
  store?: () => Promise<SongStore>;
  removals?: RemovalLog;
  /** Whether to start by finding out who is signed in (by default, if they were last time). */
  restore?: boolean;
}

/**
 * Signing in with Google and keeping the songs in step with the account's cloud copy. Nothing
 * happens until the player signs in, and Firebase isn't even loaded until then (or, for someone
 * who was signed in last time, until the page opens).
 */
export function useCloud({ refresh, backend = firebaseBackend, store = getSongStore, removals = removalLog, restore }: CloudOptions) {
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  /** What is being sent or fetched, in words; null when nothing is. */
  const [syncing, setSyncing] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Songs that stay on this device only. */
  const [notes, setNotes] = useState<readonly Skipped[]>([]);

  // What the callbacks need to be able to read without being remade each time.
  const who = useRef<CloudAccount | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastAt = useRef(0);
  const stopWatching = useRef<(() => void) | null>(null);
  const latest = useRef({ backend, store, removals, refresh });
  latest.current = { backend, store, removals, refresh };

  const sync = useCallback(async () => {
    if (!who.current) return;
    if (running.current) {
      again.current = true; // (something changed while a sync was going: go round once more)
      return;
    }
    running.current = true;
    const mine = new AbortController();
    controller.current = mine;
    try {
      do {
        again.current = false;
        const account = who.current;
        if (!account || mine.signal.aborted) break;
        setError(null);
        setSyncing('Checking the cloud');
        const { backend, store, removals, refresh } = latest.current;
        const report = await runSync({
          store: await store(),
          cloud: await backend.songs(account),
          removals,
          onProgress: (message) => {
            if (!mine.signal.aborted) setSyncing(message);
          },
          signal: mine.signal,
        });
        if (mine.signal.aborted) break;
        lastAt.current = Date.now();
        setLastSynced(lastAt.current);
        setNotes(report.skipped);
        if (report.pulled.length > 0 || report.removedHere.length > 0) await refresh();
      } while (again.current);
    } catch (failure) {
      if (!(failure instanceof Cancelled) && !mine.signal.aborted) {
        console.error('Syncing with the cloud failed', failure);
        setError(describeCloudError(failure) ?? null);
      }
    } finally {
      running.current = false;
      if (controller.current === mine) controller.current = null;
      if (!mine.signal.aborted) setSyncing(null);
      // A sync asked for while this one was being stopped (a new sign-in) still has to happen.
      if (again.current && who.current) {
        again.current = false;
        void sync();
      }
    }
  }, []);

  /** Syncs a moment from now (a run of changes makes one sync). Does nothing if nobody is signed in. */
  const syncSoon = useCallback(() => {
    if (!who.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void sync(), CHANGE_DELAY_MS);
  }, [sync]);

  const watch = useCallback(() => {
    if (stopWatching.current) return;
    stopWatching.current = latest.current.backend.watch(
      (next) => {
        who.current = next;
        remember(next !== null);
        setAccount(next);
        setRestoring(false);
      },
      (failure) => {
        console.error('Signing in failed', failure);
        setError(describeCloudError(failure) ?? null);
        setRestoring(false);
      },
    );
  }, []);

  // Someone who was signed in last time is found again as the page opens.
  const shouldRestore = restore ?? wasSignedIn();
  useEffect(() => {
    if (!shouldRestore) return;
    setRestoring(true);
    watch();
  }, [shouldRestore, watch]);

  useEffect(
    () => () => {
      stopWatching.current?.();
      stopWatching.current = null;
      controller.current?.abort();
      clearTimeout(timer.current);
    },
    [],
  );

  // While signed in: sync now, when the connection comes back, and when the player returns to the page.
  const uid = account?.uid;
  useEffect(() => {
    if (uid === undefined) {
      setSyncing(null);
      setLastSynced(null);
      setNotes([]);
      return;
    }
    void sync();
    const online = () => void sync();
    const visible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current > RETURN_AFTER_MS) void sync();
    };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      controller.current?.abort();
      clearTimeout(timer.current);
    };
  }, [uid, sync]);

  const signIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    watch();
    try {
      await latest.current.backend.signIn();
    } catch (failure) {
      const words = describeCloudError(failure);
      if (words) setError(words);
      if (words) console.error('Signing in failed', failure);
    } finally {
      setSigningIn(false);
    }
  }, [watch]);

  const signOut = useCallback(async () => {
    controller.current?.abort();
    clearTimeout(timer.current);
    try {
      await latest.current.backend.signOut();
    } catch (failure) {
      setError(describeCloudError(failure) ?? null);
    }
  }, []);

  const warmUp = useCallback(() => latest.current.backend.warmUp(), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    account,
    /** Finding out who was signed in, or the sign-in window is open. */
    connecting: restoring || signingIn,
    syncing,
    lastSynced,
    error,
    notes,
    signIn,
    signOut,
    syncNow: sync,
    syncSoon,
    warmUp,
    dismissError,
  };
}

export type Cloud = ReturnType<typeof useCloud>;
