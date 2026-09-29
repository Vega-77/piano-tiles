import { TILE_HEIGHT } from '../config';
import type { Difficulty, Song } from '../types';
import { beatRows } from './notation';

// The songs themselves are the ones a player adds (see importer.ts and library.ts); this is what the
// screens say about any of them.

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Beginner',
  2: 'Easy',
  3: 'Medium',
  4: 'Hard',
  5: 'Expert',
};

/** Total rows in one lap of the song, gaps included. */
export function songRows(song: Song): number {
  return song.beats.reduce((sum, beat) => sum + beatRows(beat), 0);
}

export function songBars(song: Song): number {
  return songRows(song) / song.rowsPerBar;
}

/** Seconds one lap takes on the first lap. */
export function songSeconds(song: Song): number {
  return (songRows(song) * TILE_HEIGHT) / song.speed;
}

export function songFeatures(song: Song): { doubles: boolean; holds: boolean } {
  return {
    doubles: song.beats.some((beat) => beat.type === 'double'),
    holds: song.beats.some((beat) => beat.type === 'hold'),
  };
}
