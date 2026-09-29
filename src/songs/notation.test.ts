import { describe, expect, it } from 'vitest';
import { beatRows, noteToFrequency, parseBars, parseBeats } from './notation';

describe('noteToFrequency', () => {
  it('maps A4 to 440 Hz and C4 to middle C', () => {
    expect(noteToFrequency('A4')).toBeCloseTo(440, 5);
    expect(noteToFrequency('C4')).toBeCloseTo(261.63, 2);
    expect(noteToFrequency('C#4')).toBeGreaterThan(noteToFrequency('C4'));
  });

  it('rejects malformed notes', () => {
    expect(() => noteToFrequency('H4')).toThrow();
    expect(() => noteToFrequency('C')).toThrow();
  });
});

describe('parseBeats', () => {
  it('parses taps, doubles, holds and rests', () => {
    const beats = parseBeats('C4 E4+G4 A4~ B4~3 D4~4 . .3');
    expect(beats.map((b) => b.type)).toEqual(['tap', 'double', 'hold', 'hold', 'hold', 'rest', 'rest']);
    expect(beats[2]).toMatchObject({ type: 'hold', rows: 2 });
    expect(beats[3]).toMatchObject({ type: 'hold', rows: 3 });
    expect(beats[4]).toMatchObject({ type: 'hold', rows: 4 });
    expect(beats[5]).toEqual({ type: 'rest', rows: 1 });
    expect(beats[6]).toEqual({ type: 'rest', rows: 3 });
  });

  it('gives doubles both pitches', () => {
    const [beat] = parseBeats('C4+E4');
    if (beat.type !== 'double') throw new Error('expected a double');
    expect(beat.freqs[0]).toBeCloseTo(noteToFrequency('C4'), 5);
    expect(beat.freqs[1]).toBeCloseTo(noteToFrequency('E4'), 5);
  });

  it('ignores extra whitespace and newlines', () => {
    expect(parseBeats('  C4 |\n D4  ')).toHaveLength(2);
  });

  it('rejects bad tokens, holds outside 2-4 rows, and doubles that hold', () => {
    expect(() => parseBeats('C4 X9')).toThrow(/Invalid token/);
    expect(() => parseBeats('C4~1')).toThrow(/rows/);
    expect(() => parseBeats('C4~5')).toThrow(/rows/);
    expect(() => parseBeats('C4+E4~2')).toThrow();
    expect(() => parseBeats('..')).toThrow();
  });
});

describe('parseBars', () => {
  it('splits a melody into bars at each |', () => {
    const bars = parseBars('C4 . D4 . | E4~3 . | F4 G4 A4 B4');
    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => bar.length)).toEqual([4, 2, 4]);
  });

  it('also ends a bar at the end of a line, so a bar never runs into the next line', () => {
    const bars = parseBars(`
      C4 . D4 . | E4 . F4 .
      G4 . A4 . | B4 . C5 .
    `);
    expect(bars.map((bar) => bar.length)).toEqual([4, 4, 4, 4]);
  });

  it('skips empty bars, such as a trailing |', () => {
    expect(parseBars('C4 D4 |\n  | E4 |')).toHaveLength(2);
  });
});

describe('beatRows', () => {
  it('counts the rows each kind of beat takes up, gaps included', () => {
    expect(beatRows({ type: 'tap', freq: 440 })).toBe(1);
    expect(beatRows({ type: 'double', freqs: [440, 550] })).toBe(1);
    expect(beatRows({ type: 'hold', freq: 440, rows: 3 })).toBe(3);
    expect(beatRows({ type: 'rest', rows: 2 })).toBe(2);
  });
});
