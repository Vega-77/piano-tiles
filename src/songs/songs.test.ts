import { describe, expect, it } from 'vitest';
import { MAX_HOLD_ROWS, MIN_HOLD_ROWS } from '../config';
import { getSong, SONGS, songBpm, songFeatures, songSeconds } from './songs';

describe('song library', () => {
  it('has unique ids and is ordered from easiest to hardest', () => {
    expect(new Set(SONGS.map((s) => s.id)).size).toBe(SONGS.length);
    const difficulties = SONGS.map((s) => s.difficulty);
    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
    expect(getSong('ode-to-joy')?.title).toBe('Ode to Joy');
    expect(getSong('nope')).toBeUndefined();
  });

  it.each(SONGS.map((s) => [s.title, s] as const))('%s is well formed', (_title, song) => {
    expect(song.beats.length).toBeGreaterThan(20);
    expect(song.speed).toBeGreaterThan(20);
    for (const beat of song.beats) {
      const freqs = beat.type === 'double' ? beat.freqs : [beat.freq];
      for (const f of freqs) expect(f).toBeGreaterThan(100);
      if (beat.type === 'hold') {
        expect(beat.rows).toBeGreaterThanOrEqual(MIN_HOLD_ROWS);
        expect(beat.rows).toBeLessThanOrEqual(MAX_HOLD_ROWS);
      }
    }
  });

  it('gets faster and busier as difficulty rises', () => {
    const speeds = SONGS.map((s) => s.speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b));
    expect(songFeatures(SONGS[0]).doubles).toBe(false);
    expect(songFeatures(SONGS[SONGS.length - 1])).toEqual({ doubles: true, holds: true });
  });

  it('derives tempo and length', () => {
    const song = SONGS[0];
    expect(songBpm(song)).toBe(Math.round((song.speed / 25) * 60));
    expect(songSeconds(song)).toBeGreaterThan(10);
  });
});
