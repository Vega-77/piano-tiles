import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadImportedSongs } from '../songs/library';
import { SONGS } from '../songs/songs';
import type { Song } from '../types';

const BUILT_IN_IDS = SONGS.map((song) => song.id);

/** Every song there is to play: the built-in ones, then the ones imported from recordings. */
export function useLibrary() {
  const [imported, setImported] = useState<readonly Song[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const latest = useRef(0);

  /** Reads the imported songs again (after one was added, changed or removed). */
  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    const library = await loadImportedSongs(undefined, undefined, BUILT_IN_IDS);
    // (An older read that finished late must not undo a newer one.)
    if (ticket !== latest.current) return;
    setImported(library.songs);
    setProblems(library.problems);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const songs = useMemo<readonly Song[]>(() => [...SONGS, ...imported], [imported]);
  return { songs, problems, refresh };
}
