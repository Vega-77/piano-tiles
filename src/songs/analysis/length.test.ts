import { describe, expect, it } from 'vitest';
import { FPS, type Features } from './features';
import type { Grid } from './grid';
import { DEFAULT_LENGTH, LENGTHS, LENGTH_SECONDS, chooseEnd, lengthFrom } from './length';

/** A recording that is `level(time)` loud all the way through. Only the loudness matters for choosing a stop. */
function recording(seconds: number, level: (time: number) => number = () => 1): Features {
  const empty = new Float64Array(0);
  const rms = Float64Array.from({ length: Math.ceil(seconds * FPS) }, (_, i) => level(i / FPS));
  return { env: empty, low: empty, mid: empty, high: empty, rms, duration: seconds };
}

/** 120 BPM with two rows to a beat: a beat is 0.5 s and a bar 2 s, the first beat 0.3 s in. */
const GRID: Grid = { rate: 4, phase: 0.3, score: 1, contrast: 1 };
const BAR = 2;

const barLine = (bars: number) => GRID.phase + bars * BAR;

describe('the length of a lap', () => {
  it('has three ranges that together cover 60 to 90 seconds', () => {
    expect(LENGTHS).toEqual(['short', 'medium', 'long']);
    expect(LENGTH_SECONDS.short.min).toBe(60);
    expect(LENGTH_SECONDS.long.max).toBe(90);
    expect(LENGTH_SECONDS.short.max).toBe(LENGTH_SECONDS.medium.min);
    expect(LENGTH_SECONDS.medium.max).toBe(LENGTH_SECONDS.long.min);
    expect(DEFAULT_LENGTH).toBe('medium');
  });

  it('reads the length a chart was saved with, and anything odd as the middle one', () => {
    expect(LENGTHS.map(lengthFrom)).toEqual(LENGTHS);
    expect(lengthFrom('endless')).toBe('medium');
    expect(lengthFrom(undefined)).toBe('medium');
    expect(lengthFrom(80)).toBe('medium');
  });
});

describe('where a long song stops', () => {
  it('plays a song that fits the range whole', () => {
    expect(chooseEnd(recording(45), GRID, 2, 45, 'medium')).toBeUndefined();
    expect(chooseEnd(recording(80), GRID, 2, 80, 'medium')).toBeUndefined(); // (right on the top of the range)
    expect(chooseEnd(recording(85), GRID, 2, 85, 'long')).toBeUndefined();
  });

  it('stops a longer one on a bar line inside the range asked for', () => {
    for (const length of LENGTHS) {
      const { min, max } = LENGTH_SECONDS[length];
      const end = chooseEnd(recording(200), GRID, 2, 200, length)!;
      expect(end).toBeGreaterThanOrEqual(min);
      expect(end).toBeLessThanOrEqual(max);
      const bars = (end - GRID.phase) / BAR;
      expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-9);
    }
  });

  it('prefers the end of a phrase: every eight bars over four, four over two, two over one', () => {
    // Medium is 70–80 s: with a 2 s bar from 0.3 s, bar lines 35 to 39. Bar 36 ends a four-bar phrase.
    expect(chooseEnd(recording(200), GRID, 2, 200, 'medium')).toBeCloseTo(barLine(36), 9);
    // Long is 80–90 s: bar lines 40 to 44. Bar 40 ends an eight-bar phrase, over bar 44's four.
    expect(chooseEnd(recording(200), GRID, 2, 200, 'long')).toBeCloseTo(barLine(40), 9);
    // Short is 60–70 s: bar lines 30 to 34. Bar 32 ends an eight-bar phrase.
    expect(chooseEnd(recording(200), GRID, 2, 200, 'short')).toBeCloseTo(barLine(32), 9);
  });

  it('takes a quiet moment over a plainer phrase end', () => {
    // The music drops out around bar line 38, a two-bar phrase end, so it beats bar 36's four-bar one.
    const dropsOut = recording(200, (time) => (Math.abs(time - barLine(38)) < 0.4 ? 0 : 1));
    expect(chooseEnd(dropsOut, GRID, 2, 200, 'medium')).toBeCloseTo(barLine(38), 9);
  });

  it('does not let a shallow dip at an odd bar outweigh a phrase end', () => {
    // Bar line 37 is worth nothing as a phrase, and a dip to 70% earns well under 2 for being quiet.
    const shallow = recording(200, (time) => (Math.abs(time - barLine(37)) < 0.4 ? 0.7 : 1));
    expect(chooseEnd(shallow, GRID, 2, 200, 'medium')).toBeCloseTo(barLine(36), 9);
  });

  it('gives a tie to the later stop, for more of the song', () => {
    // Long: bar 40 scores 3 (eight-bar phrase, nothing quiet) and bar 42 scores 1 + 2 for a total silence around it.
    const silentAt42 = recording(200, (time) => (Math.abs(time - barLine(42)) < 0.4 ? 0 : 1));
    expect(chooseEnd(silentAt42, GRID, 2, 200, 'long')).toBeCloseTo(barLine(42), 9);
  });

  it('stops where the range ends if not one bar line falls in it', () => {
    // A 16 s bar (four rows a beat would never give one, but the arithmetic must not fall over) from 1 s: 65 s, 81 s.
    const slow: Grid = { rate: 0.25, phase: 1, score: 1, contrast: 1 };
    expect(chooseEnd(recording(200), slow, 1, 200, 'medium')).toBe(80);
  });

  it('copes with silence', () => {
    const end = chooseEnd(recording(200, () => 0), GRID, 2, 200, 'medium')!;
    expect(end).toBeCloseTo(barLine(36), 9);
  });
});
