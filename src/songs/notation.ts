import { MAX_HOLD_ROWS, MIN_HOLD_ROWS } from '../config';
import type { BeatSpec } from '../types';

const SEMITONES: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

/** 'A4' -> 440 Hz */
export function noteToFrequency(note: string): number {
  const match = /^([A-G]#?)(\d)$/.exec(note);
  if (!match) throw new Error(`Invalid note "${note}"`);
  const midi = 12 * (Number(match[2]) + 1) + SEMITONES[match[1]];
  return 440 * 2 ** ((midi - 69) / 12);
}

const NOTE = '[A-G]#?\\d';
const TOKEN = new RegExp(`^(${NOTE})(?:\\+(${NOTE})|~(\\d)?)?$`);

/**
 * Parses a song written as whitespace-separated tokens (`|` is ignored, so bars can be marked):
 *   E4        a tap tile
 *   C4+E4     a double: two tiles at once, one lane apart (plays both notes)
 *   G4~       a hold tile, 2 rows long
 *   G4~3      a hold tile, 3 rows long (2–4 allowed)
 */
export function parseBeats(source: string): BeatSpec[] {
  return source
    .split(/[\s|]+/)
    .filter(Boolean)
    .map((token): BeatSpec => {
      const match = TOKEN.exec(token);
      if (!match) throw new Error(`Invalid token "${token}"`);
      const [, note, partner, rowsText] = match;

      if (partner) return { type: 'double', freqs: [noteToFrequency(note), noteToFrequency(partner)] };
      if (token.includes('~')) {
        const rows = rowsText ? Number(rowsText) : MIN_HOLD_ROWS;
        if (rows < MIN_HOLD_ROWS || rows > MAX_HOLD_ROWS) {
          throw new Error(`Hold "${token}" must be ${MIN_HOLD_ROWS}–${MAX_HOLD_ROWS} rows long`);
        }
        return { type: 'hold', freq: noteToFrequency(note), rows };
      }
      return { type: 'tap', freq: noteToFrequency(note) };
    });
}
