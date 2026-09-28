import { describe, expect, it } from 'vitest';
import { noteToFrequency, parseBeats } from './notation';

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
  it('parses taps, doubles and holds', () => {
    const beats = parseBeats('C4 E4+G4 A4~ B4~3 | D4~4');
    expect(beats.map((b) => b.type)).toEqual(['tap', 'double', 'hold', 'hold', 'hold']);
    expect(beats[1]).toMatchObject({ type: 'double' });
    expect(beats[2]).toMatchObject({ type: 'hold', rows: 2 });
    expect(beats[3]).toMatchObject({ type: 'hold', rows: 3 });
    expect(beats[4]).toMatchObject({ type: 'hold', rows: 4 });
  });

  it('gives doubles both pitches', () => {
    const [beat] = parseBeats('C4+E4');
    if (beat.type !== 'double') throw new Error('expected a double');
    expect(beat.freqs[0]).toBeCloseTo(noteToFrequency('C4'), 5);
    expect(beat.freqs[1]).toBeCloseTo(noteToFrequency('E4'), 5);
  });

  it('ignores bar lines and extra whitespace', () => {
    expect(parseBeats('  C4 |\n D4  ')).toHaveLength(2);
  });

  it('rejects bad tokens, holds outside 2-4 rows, and doubles that hold', () => {
    expect(() => parseBeats('C4 X9')).toThrow(/Invalid token/);
    expect(() => parseBeats('C4~1')).toThrow(/rows/);
    expect(() => parseBeats('C4~5')).toThrow(/rows/);
    expect(() => parseBeats('C4+E4~2')).toThrow();
  });
});
