import { TILE_HEIGHT } from '../config';
import type { Difficulty, Groove, Song } from '../types';
import { buildTrack } from './arrangement';
import { beatRows, parseBars } from './notation';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Beginner',
  2: 'Easy',
  3: 'Medium',
  4: 'Hard',
  5: 'Expert',
};

interface SongDefinition {
  id: string;
  title: string;
  composer: string;
  description: string;
  difficulty: Difficulty;
  bpm: number;
  /** Rows (the song's smallest step) per beat, and per bar. */
  rowsPerBeat: number;
  rowsPerBar: number;
  hue: number;
  hue2: number;
  /** The melody, bar by bar (bars separated by `|`). Every bar must add up to `rowsPerBar` rows. */
  notes: string;
  /** One chord per bar, or two joined by "/" to change halfway through. */
  chords: string;
  groove: Groove;
}

// Every song is written on an eighth-note grid: one row is an eighth note, so a quarter note
// is a tap followed by a rest, and a half note is a hold (a row shorter than it sounds, so
// there is a breather before the next tile).
const DEFINITIONS: SongDefinition[] = [
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    composer: 'Traditional',
    description: 'A gentle lullaby with a soft beat. A tile on every beat, and short holds to end each line.',
    difficulty: 1,
    bpm: 112,
    rowsPerBeat: 2,
    rowsPerBar: 8,
    hue: 200,
    hue2: 255,
    notes: `
      C4 . C4 . G4 . G4 .   | A4 . A4 . G4~3 .   | F4 . F4 . E4 . E4 .   | D4 . D4 . C4~3 .
      G4 . G4 . F4 . F4 .   | E4 . E4 . D4~3 .   | G4 . G4 . F4 . F4 .   | E4 . E4 . D4~3 .
      C4 . C4 . G4 . G4 .   | A4 . A4 . G4~3 .   | F4 . F4 . E4 . E4 .   | D4 . D4 . C4~3 .
    `,
    chords: 'C F/C F/C G/C  C/F C/G C/F C/G  C F/C F/C G/C',
    groove: { kick: 'x...x...', snare: '..o...o.', hat: 'xoxoxoxo', bass: '1...5...', chord: '..x...x.', pad: true },
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    composer: 'Ludwig van Beethoven',
    description: 'The famous finale theme over a bright, bouncing beat. Steady taps, with long held notes to end each phrase.',
    difficulty: 2,
    bpm: 132,
    rowsPerBeat: 2,
    rowsPerBar: 8,
    hue: 145,
    hue2: 195,
    notes: `
      E4 . E4 . F4 . G4 .   | G4 . F4 . E4 . D4 .   | C4 . C4 . D4 . E4 .   | E4~3 D4 . D4~2 .
      E4 . E4 . F4 . G4 .   | G4 . F4 . E4 . D4 .   | C4 . C4 . D4 . E4 .   | D4~3 C4 . C4~2 .
      D4 . D4 . E4 . C4 .   | D4 . E4 . F4 . E4 .   | D4 . E4 . F4 . D4 .   | C4 . D4 . G3~3 .
      E4 . E4 . F4 . G4 .   | G4 . F4 . E4 . D4 .   | C4 . C4 . D4 . E4 .   | D4~3 C4 . C4~2 .
    `,
    chords: 'C G C C/G  C G C G/C  G/C G7/C G7/C C/G  C G C G/C',
    groove: { kick: 'x...x...', snare: '..x...x.', hat: 'xoxoxoxo', bass: '1...5.1.', chord: '..x...x.', pad: true },
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    composer: 'Ludwig van Beethoven',
    description: 'A waltz in three. Fluttering runs, held notes, and your first double tiles: keep two fingers ready.',
    difficulty: 3,
    bpm: 80,
    rowsPerBeat: 2,
    rowsPerBar: 6,
    hue: 320,
    hue2: 275,
    notes: `
      E5 D#5 E5 D#5 E5 B4   | D5 C5 A4~3 .        | C4 E4 A4 B4~2 .      | E4 G#4 B4 C5~2 .
      E5 D#5 E5 D#5 E5 B4   | D5 C5 A4~3 .        | C4 E4 A4 B4~2 .      | E4 C5 B4 A4+A3 . .
      B4 C5 D5 E5~2 .       | G4 F5 E5 D5~2 .     | F4 E5 D5 C5~2 .      | E4 D5 C5 B4+E4 . .
    `,
    chords: 'Am Am Am/E7 E7/Am  Am Am Am/E7 Am  C G7 F/C E7',
    groove: { kick: 'x.....', snare: '..o.o.', hat: 'x.o.o.', bass: '1.....', chord: '..x.x.', pad: true },
  },
  {
    id: 'rondo-alla-turca',
    title: 'Rondo Alla Turca',
    composer: 'Wolfgang Amadeus Mozart',
    description: 'A rousing march. Fast sparkling runs, then doubles, then a soaring second theme.',
    difficulty: 4,
    bpm: 90,
    rowsPerBeat: 2,
    rowsPerBar: 4,
    hue: 22,
    hue2: 345,
    notes: `
      B4 A4 G#4 A4 | C5~3 . | D5 C5 B4 C5 | E5~3 .
      F5 E5 D#5 E5 | B5 A5 G#5 A5 | B5 A5 G#5 A5 | C6~3 .
      B4 A4 G#4 A4 | C5+E5 . . . | D5 C5 B4 C5 | E5+G5 . . .
      F5 E5 D#5 E5 | B5 A5 G#5 A5 | B5 A5 G#5 A5 | C6+A5 . . .
      A5 G5 F#5 G5 | B5~3 . | C6 B5 A#5 B5 | D6~3 .
      E6 D#6 D6 D#6 | A5 G5 F#5 G5 | A5 G5 F#5 G5 | B5~4
    `,
    chords: 'E7 Am Am/E7 Am  Dm/E7 E7 E7 Am  E7 Am Am/E7 Am  Dm/E7 E7 E7 Am  G G Em Em/G  G G G E7',
    groove: { kick: 'x...', snare: '..x.', hat: 'xoxo', bass: '1.5.', chord: '.x.x', pad: false },
  },
  {
    id: 'mountain-king',
    title: 'In the Hall of the Mountain King',
    composer: 'Edvard Grieg',
    description: 'A creeping theme that never stops climbing. Runs, holds and doubles come thick and fast.',
    difficulty: 5,
    bpm: 102,
    rowsPerBeat: 2,
    rowsPerBar: 4,
    hue: 350,
    hue2: 268,
    notes: `
      B3 C#4 D4 E4 | F#4 D4 F#4~2 | F4 C#4 F4~2 | E4 C4 E4~2
      B3 C#4 D4 E4 | F#4 D4 F#4 B4 | A4 F#4 D4 F#4 | A4~3 .
      B4 C#5 D5 E5 | F#5 D5 F#5+B5 . | F5 C#5 F5+A5 . | E5 C5 E5+G5 .
      B4 C#5 D5 E5 | F#5 D5 F#5 B5 | A5 F#5 D5 F#5 | B4+F#5 . . .
      B3 C#4 D4 E4 | F#4 D4 F#4~2 | F4 C#4 F4~2 | E4 C4 E4~2
      B4 C#5 D5 E5 | F#5 D5 F#5 B5 | A5 F#5 D5 F#5 | B5~4
    `,
    chords: 'Bm Bm Bm Bm  Bm Bm Bm F#  Bm Bm Bm Bm  Bm Bm Bm F#  Bm Bm Bm Bm  Bm Bm Bm F#',
    groove: { kick: 'x.x.', snare: '.o.x', hat: 'xoxo', bass: '1.8.', chord: '..x.', pad: true },
  },
];

function define(def: SongDefinition): Song {
  const bars = parseBars(def.notes);
  bars.forEach((bar, i) => {
    const rows = bar.reduce((sum, beat) => sum + beatRows(beat), 0);
    if (rows !== def.rowsPerBar) {
      throw new Error(`${def.title}: bar ${i + 1} has ${rows} rows, expected ${def.rowsPerBar}`);
    }
  });

  const chords = def.chords.split(/\s+/).filter(Boolean);
  if (chords.length !== bars.length) {
    throw new Error(`${def.title}: ${chords.length} chords for ${bars.length} bars`);
  }
  for (const [name, pattern] of Object.entries(def.groove)) {
    if (typeof pattern === 'string' && pattern.length !== def.rowsPerBar) {
      throw new Error(`${def.title}: groove "${name}" must be ${def.rowsPerBar} rows long`);
    }
  }

  const { notes: _notes, chords: _chords, groove, ...meta } = def;
  const beats = bars.flat();
  return {
    ...meta,
    speed: ((def.bpm * def.rowsPerBeat) / 60) * TILE_HEIGHT,
    beats,
    track: buildTrack(beats, { rowsPerBar: def.rowsPerBar, chords, groove }),
  };
}

export const SONGS: readonly Song[] = DEFINITIONS.map(define);

export function getSong(id: string): Song | undefined {
  return SONGS.find((song) => song.id === id);
}

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
