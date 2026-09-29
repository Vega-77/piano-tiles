import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadStoredSongs } from '../songs/library';
import { SONGS } from '../songs/songs';
import { getSongStore } from '../songs/store';
import type { Song } from '../types';

const BUILT_IN_IDS = SONGS.map((song) => song.id);

/** Every song there is to play: the built-in ones, then the ones added on this device. */
export function useLibrary() {
  const [added, setAdded] = useState<readonly Song[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [persistent, setPersistent] = useState(true);
  const latest = useRef(0);

  /** Reads the saved songs again (after one was added, changed or removed). */
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    const store = await getSongStore();
    const library = await loadStoredSongs(store, BUILT_IN_IDS);
    // (An older read that finished late must not undo a newer one.)
    if (ticket !== latest.current) return;
    setAdded(library.songs);
    setProblems(library.problems);
    setPersistent(store.persistent);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const songs = useMemo<readonly Song[]>(() => [...SONGS, ...added], [added]);
  return { songs, problems, persistent, refresh };
}
