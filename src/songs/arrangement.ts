import type { BeatSpec, Groove, MusicEvent } from '../types';
import { beatRows, midiToFrequency } from './notation';

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const CHORD = /^([A-G])([#b]?)(m|dim)?(7)?$/;

/**
 * MIDI notes of a chord with its root in the given octave. Understands C, Cm, C7, Cm7, Cdim,
 * and sharps/flats on the root (F#, Bb, ...).
 */
export function chordMidi(name: string, octave: number): number[] {
  const match = CHORD.exec(name);
  if (!match) throw new Error(`Invalid chord "${name}"`);
  const [, letter, accidental, quality, seventh] = match;
  const root = 12 * (octave + 1) + SEMITONES[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  const triad = quality === 'm' ? [0, 3, 7] : quality === 'dim' ? [0, 3, 6] : [0, 4, 7];
  const notes = seventh ? [...triad, 10] : triad;
  return notes.map((interval) => root + interval);
}

export interface Arrangement {
  rowsPerBar: number;
  /** One entry per bar: a chord name, or two joined with "/" to change chord halfway through the bar. */
  chords: readonly string[];
  groove: Groove;
}

/** The chord playing at a given row of a bar. */
function chordAt(entry: string, row: number, rowsPerBar: number): string {
  const parts = entry.split('/');
  return parts.length > 1 && row >= rowsPerBar / 2 ? parts[1] : parts[0];
}

/**
 * Lays a whole song out row by row: the melody where its notes fall, plus (when an
 * arrangement is given) the drums, bass and chords of the groove, following the chords bar by
 * bar. The result is one list of events per row of a single lap.
 */
export function buildTrack(beats: readonly BeatSpec[], arrangement?: Arrangement): MusicEvent[][] {
  const totalRows = beats.reduce((sum, beat) => sum + beatRows(beat), 0);
  const track: MusicEvent[][] = Array.from({ length: totalRows }, () => []);

  let row = 0;
  for (const beat of beats) {
    if (beat.type === 'tap') track[row].push({ kind: 'melody', freq: beat.freq });
    else if (beat.type === 'double') for (const freq of beat.freqs) track[row].push({ kind: 'melody', freq });
    // A hold rings for most of its length.
    else if (beat.type === 'hold') track[row].push({ kind: 'melody', freq: beat.freq, rows: beat.rows - 0.4 });
    row += beatRows(beat);
  }
  if (!arrangement) return track;

  const { rowsPerBar, chords, groove } = arrangement;
  const bars = totalRows / rowsPerBar;
  for (let bar = 0; bar < bars; bar++) {
    const entry = chords[bar];
    const base = bar * rowsPerBar;

    for (let j = 0; j < rowsPerBar; j++) {
      const events = track[base + j];
      if (groove.kick[j] !== '.') events.push({ kind: 'kick' });
      if (groove.snare[j] !== '.') events.push({ kind: 'snare', soft: groove.snare[j] === 'o' });
      if (groove.hat[j] !== '.') events.push({ kind: 'hat', soft: groove.hat[j] === 'o' });

      const bassStep = groove.bass[j];
      if (bassStep !== '.') {
        const root = chordMidi(chordAt(entry, j, rowsPerBar), 2)[0];
        const midi = bassStep === '5' ? root + 7 : bassStep === '8' ? root + 12 : root;
        // A bass note rings until the next one (or the end of the bar).
        let next = j + 1;
        while (next < rowsPerBar && groove.bass[next] === '.') next++;
        events.push({ kind: 'bass', freq: midiToFrequency(midi), rows: next - j });
      }

      if (groove.chord[j] !== '.') {
        const notes = chordMidi(chordAt(entry, j, rowsPerBar), 3).map(midiToFrequency);
        events.push({ kind: 'chord', freqs: notes, rows: 1 });
      }
    }

    if (groove.pad) {
      const parts = entry.split('/');
      const span = rowsPerBar / parts.length;
      parts.forEach((name, i) => {
        const notes = chordMidi(name, 3).map(midiToFrequency);
        track[base + i * span].push({ kind: 'chord', freqs: notes, rows: span, pad: true });
      });
    }
  }
  return track;
}
