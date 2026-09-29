import { describe, expect, it } from 'vitest';
import { MAX_HOLD_ROWS, MIN_HOLD_ROWS, TILE_HEIGHT } from '../config';
import { beatRows } from './notation';
import { getSong, SONGS, songBars, songFeatures, songRows, songSeconds } from './songs';

describe('song library', () => {
  it('has unique ids and is ordered from easiest to hardest', () => {
    expect(new Set(SONGS.map((s) => s.id)).size).toBe(SONGS.length);
    const difficulties = SONGS.map((s) => s.difficulty);
    expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
    expect(getSong('ode-to-joy')?.title).toBe('Ode to Joy');
    expect(getSong('nope')).toBeUndefined();
  });

  it.each(SONGS.map((s) => [s.title, s] as const))('%s is well formed', (_title, song) => {
    // (The loader already refuses a bar that doesn't add up or a chord list of the wrong length.)
    expect(songRows(song) % song.rowsPerBar).toBe(0);
    expect(songBars(song)).toBeGreaterThanOrEqual(12);
    expect(song.track).toHaveLength(songRows(song));

    for (const beat of song.beats) {
      const freqs = beat.type === 'double' ? beat.freqs : beat.type === 'rest' ? [] : [beat.freq];
      for (const f of freqs) expect(f).toBeGreaterThan(100);
      if (beat.type === 'hold') {
        expect(beat.rows).toBeGreaterThanOrEqual(MIN_HOLD_ROWS);
        expect(beat.rows).toBeLessThanOrEqual(MAX_HOLD_ROWS);
      }
    }
  });

  it.each(SONGS.map((s) => [s.title, s] as const))('%s has gaps between its tiles', (_title, song) => {
    const rests = song.beats.filter((b) => b.type === 'rest');
    expect(rests.length).toBeGreaterThan(0);
    const tiles = song.beats.filter((b) => b.type !== 'rest').length;
    // Not a rest on every beat, and not a tile on every beat either.
    expect(tiles).toBeGreaterThan(rests.length / 2);
  });

  it.each(SONGS.map((s) => [s.title, s] as const))('%s plays as a whole song, not just a melody', (_title, song) => {
    const kinds = new Set(song.track.flat().map((event) => event.kind));
    for (const kind of ['melody', 'kick', 'snare', 'hat', 'bass', 'chord'] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
    // The band never plays a note the tiles don't ask for: every tile's note is in the track.
    const melody = song.track.flat().filter((event) => event.kind === 'melody').length;
    const notes = song.beats.reduce(
      (sum, beat) => sum + (beat.type === 'double' ? 2 : beat.type === 'rest' ? 0 : 1),
      0,
    );
    expect(melody).toBe(notes);
  });

  it('derives the fall speed from the tempo', () => {
    for (const song of SONGS) {
      expect(song.speed).toBeCloseTo(((song.bpm * song.rowsPerBeat) / 60) * TILE_HEIGHT, 9);
    }
  });

  /** The fastest the player has to tap, in taps per second, on the first lap. */
  function peakTapRate(song: (typeof SONGS)[number]): number {
    let start = 0;
    let previous = -1;
    let closest = Infinity;
    for (const beat of song.beats) {
      if (beat.type !== 'rest') {
        if (previous >= 0) closest = Math.min(closest, start - previous);
        previous = start;
      }
      start += beatRows(beat);
    }
    return song.speed / TILE_HEIGHT / closest;
  }

  it('starts at least 30% quicker than it used to', () => {
    // The peak tap rate of each song before the pace was raised.
    const before: Record<string, number> = {
      twinkle: 1.36, 'ode-to-joy': 1.68, 'fur-elise': 1.84, 'rondo-alla-turca': 2.16, 'mountain-king': 2.4,
    };
    for (const song of SONGS) expect(peakTapRate(song), song.title).toBeGreaterThanOrEqual(before[song.id] * 1.3);
  });

  it('gets faster and busier as difficulty rises', () => {
    const rates = SONGS.map(peakTapRate);
    expect(rates).toEqual([...rates].sort((a, b) => a - b)); // Easy is never harder to tap than Medium
    expect(songFeatures(SONGS[0]).doubles).toBe(false);
    expect(songFeatures(SONGS[SONGS.length - 1])).toEqual({ doubles: true, holds: true });
  });

  it('gives every song a lap long enough to settle into', () => {
    for (const song of SONGS) expect(songSeconds(song)).toBeGreaterThan(20);
  });
});
