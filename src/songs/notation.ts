import { MAX_HOLD_ROWS, MIN_HOLD_ROWS } from '../config';
import type { BeatSpec } from '../types';

const SEMITONES: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** MIDI note number -> Hz (69 = A4 = 440 Hz). */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 'A4' -> 440 Hz */
export function noteToFrequency(note: string): number {
  const match = /^([A-G]#?)(\d)$/.exec(note);
  if (!match) throw new Error(`Invalid note "${note}"`);
  return midiToFrequency(12 * (Number(match[2]) + 1) + SEMITONES[match[1]]);
}

const NOTE = '[A-G]#?\\d';
const TOKEN = new RegExp(`^(${NOTE})(?:\\+(${NOTE}))?(~(\\d)?)?$`);
const REST = /^\.(\d)?$/;

/** How many rows of the song a beat takes up. */
export function beatRows(beat: BeatSpec): number {
  return beat.type === 'hold' || beat.type === 'doublehold' || beat.type === 'rest' ? beat.rows : 1;
}

function parseToken(token: string): BeatSpec {
  const rest = REST.exec(token);
  if (rest) return { type: 'rest', rows: rest[1] ? Number(rest[1]) : 1 };

  const match = TOKEN.exec(token);
  if (!match) throw new Error(`Invalid token "${token}"`);
  const [, note, partner, held, rowsText] = match;

  if (held) {
    const rows = rowsText ? Number(rowsText) : MIN_HOLD_ROWS;
    if (rows < MIN_HOLD_ROWS || rows > MAX_HOLD_ROWS) {
      throw new Error(`Hold "${token}" must be ${MIN_HOLD_ROWS}–${MAX_HOLD_ROWS} rows long`);
    }
    if (partner) return { type: 'doublehold', freqs: [noteToFrequency(note), noteToFrequency(partner)], rows };
    return { type: 'hold', freq: noteToFrequency(note), rows };
  }
  if (partner) return { type: 'double', freqs: [noteToFrequency(note), noteToFrequency(partner)] };
  return { type: 'tap', freq: noteToFrequency(note) };
}

/**
 * Parses a song's melody, written as whitespace-separated tokens. A bar ends at a `|` or at the
 * end of a line:
 *   E4        a tap tile (one row)
 *   C4+E4     a double: two tiles at once, one lane apart (plays both notes)
 *   G4~       a hold tile, 2 rows tall
 *   G4~3      a hold tile, 3 rows tall (2–4 allowed)
 *   C4+E4~3   a double hold: two hold tiles at once, one lane apart
 *   .         a rest: one row with nothing to tap
 *   .3        a rest three rows long
 * Returns one array of beats per bar.
 */
export function parseBars(source: string): BeatSpec[][] {
  return source
    .split(/\||\n/)
    .map((bar) => bar.split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => tokens.map(parseToken));
}

/** The same as parseBars, flattened. */
export function parseBeats(source: string): BeatSpec[] {
  return parseBars(source).flat();
}
