import { useCallback, useEffect, useRef, useState } from 'react';
import { loadStoredSongs } from '../songs/library';
import { getSongStore } from '../songs/store';
import type { Song } from '../types';

/** Every song there is to play: the ones added on this device. */
export function useLibrary() {
  const [songs, setSongs] = useState<readonly Song[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [persistent, setPersistent] = useState(true);
  /** False until the saved songs have been read once, so an empty list isn't mistaken for "none". */
  const [ready, setReady] = useState(false);
  const latest = useRef(0);

  /** Reads the saved songs again (after one was added, changed or removed). */
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    const store = await getSongStore();
    const library = await loadStoredSongs(store);
    // (An older read that finished late must not undo a newer one.)
    if (ticket !== latest.current) return;
    setSongs(library.songs);
    setProblems(library.problems);
    setPersistent(store.persistent);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { songs, problems, persistent, ready, refresh };
}
