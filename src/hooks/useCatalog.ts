import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudError, describeCloudError } from '../cloud/errors';
import { firebaseBackend } from '../cloud/firebase';
import { ensureAudio, syncCatalog } from '../cloud/reconcile';
import type { CloudBackend, RemoteSong } from '../cloud/types';
import { MISSING_AUDIO, getSongStore, type SongStore } from '../songs/store';
import type { Prepare } from './useGame';

/** Coming back to the page looks again if the last look was longer ago than this (a song may have been published meanwhile). */
const RETURN_AFTER_MS = 60_000;

export interface CatalogOptions {
  /** Reads the library again, once the published songs have changed what is on this device. */
  refresh: () => Promise<void>;
  backend?: CloudBackend;
  store?: () => Promise<SongStore>;
}

/**
 * The songs everyone plays, which are published in the cloud: this device's copies are brought in
 * step with them when the page opens, when the connection comes back, and when the player returns
 * to the page. A song's chart is fetched at once, and its audio (the big part) when it is first played.
 */
export function useCatalog({ refresh, backend = firebaseBackend, store = getSongStore }: CatalogOptions) {
  const [syncing, setSyncing] = useState(false);
  /** Why the published songs couldn't be looked at (in words), or null. The songs already here still play. */
  const [error, setError] = useState<string | null>(null);

  const latest = useRef({ refresh, backend, store });
  latest.current = { refresh, backend, store };
  const published = useRef(new Map<string, RemoteSong>());
  const running = useRef<Promise<void> | null>(null);
  const lastAt = useRef(0);
  const problem = useRef<string | null>(null);

  /** Looks at the published songs and brings this device's in step; joins one already going. Never rejects: a failure is `error`. */
  const sync = useCallback((): Promise<void> => {
    if (running.current) return running.current;
    const job = (async () => {
      setSyncing(true);
      try {
        const { backend, store, refresh } = latest.current;
        const result = await syncCatalog(await store(), await backend.catalog());
        published.current = result.published;
        lastAt.current = Date.now();
        problem.current = null;
        setError(null);
        if (result.changed) await refresh();
      } catch (failure) {
        console.error('Looking at the published songs failed', failure);
        problem.current = describeCloudError(failure) ?? null;
        setError(problem.current);
      } finally {
        running.current = null;
        setSyncing(false);
      }
    })();
    running.current = job;
    return job;
  }, []);

  useEffect(() => {
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
    };
  }, [sync]);

  /** Makes sure a song can be played: fetches its audio from the cloud if this device has only its chart. */
  const prepare = useCallback<Prepare>(
    async (song, progress) => {
      const { backend, store } = latest.current;
      const local = await store();
      if (await local.audio(song.id)) return;
      if (!published.current.has(song.id)) await sync(); // (the page has only just opened)
      const remote = published.current.get(song.id);
      if (!remote) throw new CloudError(problem.current ?? MISSING_AUDIO);
      try {
        await ensureAudio(local, await backend.catalog(), remote, { progress });
      } catch (failure) {
        throw new CloudError(describeCloudError(failure) ?? 'The song could not be downloaded.');
      }
    },
    [sync],
  );

  return { syncing, error, sync, prepare };
}
