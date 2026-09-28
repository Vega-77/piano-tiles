import { TILE_HEIGHT } from '../config';
import type { Difficulty, Song } from '../types';
import { parseBeats } from './notation';

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Beginner',
  2: 'Easy',
  3: 'Medium',
  4: 'Hard',
  5: 'Expert',
};

type SongDefinition = Omit<Song, 'beats'> & { notes: string };

const DEFINITIONS: SongDefinition[] = [
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    composer: 'Traditional',
    description: 'A gentle lullaby. Short holds at the end of each line teach you the ropes.',
    difficulty: 1,
    speed: 34,
    hue: 200,
    hue2: 255,
    notes: `
      C4 C4 G4 G4 A4 A4 G4~2 | F4 F4 E4 E4 D4 D4 C4~2
      G4 G4 F4 F4 E4 E4 D4~2 | G4 G4 F4 F4 E4 E4 D4~2
      C4 C4 G4 G4 A4 A4 G4~2 | F4 F4 E4 E4 D4 D4 C4~3
    `,
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    composer: 'Ludwig van Beethoven',
    description: 'The famous finale theme. Steady taps with a hold to close each phrase.',
    difficulty: 2,
    speed: 42,
    hue: 145,
    hue2: 195,
    notes: `
      E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4 D4 D4~2
      E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4 C4 C4~2
      D4 D4 E4 C4 | D4 E4 F4 E4 C4 | D4 E4 F4 E4 D4 | C4 D4 G3~2
      E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4 C4 C4~3
    `,
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    composer: 'Ludwig van Beethoven',
    description: 'Flowing arpeggios with your first double tiles: keep two fingers ready.',
    difficulty: 3,
    speed: 46,
    hue: 320,
    hue2: 275,
    notes: `
      E5 D#5 E5 D#5 E5 B4 D5 C5 A4~2 | C4 E4 A4 B4~2 | E4 G#4 B4 C5+E4
      E5 D#5 E5 D#5 E5 B4 D5 C5 A4~2 | C4 E4 A4 B4~2 | E4 C5 B4 A4+A3
      B4 C5 D5 E5~3 | G4 F5 E5 D5~3 | F4 E5 D5 C5~3 | E4 D5 C5 B4+E4
    `,
  },
  {
    id: 'rondo-alla-turca',
    title: 'Rondo Alla Turca',
    composer: 'Wolfgang Amadeus Mozart',
    description: 'Fast, sparkling runs punctuated by doubles and long held notes.',
    difficulty: 4,
    speed: 54,
    hue: 22,
    hue2: 345,
    notes: `
      B4 A4 G#4 A4 C5~2 | D5 C5 B4 C5 E5~2
      F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6~3
      B4 A4 G#4 A4 C5+E5 | D5 C5 B4 C5 E5+G5
      F5 E5 D#5 E5 B5 A5 G#5 A5 B5 A5 G#5 A5 C6+A5
      A5 G5 F#5 G5 B5~2 | C6 B5 A#5 B5 D6~2 | E6 D#6 D6 D#6 A5 G5 F#5 G5 A5 G5 F#5 G5 B5~4
    `,
  },
  {
    id: 'mountain-king',
    title: 'In the Hall of the Mountain King',
    composer: 'Edvard Grieg',
    description: 'A creeping theme that keeps accelerating. Doubles and holds come thick and fast.',
    difficulty: 5,
    speed: 60,
    hue: 350,
    hue2: 268,
    notes: `
      B3 C#4 D4 E4 F#4 D4 F#4~2 | F4 C#4 F4~2 | E4 C4 E4~2
      B3 C#4 D4 E4 F#4 D4 F#4 B4 A4 F#4 D4 F#4 A4~3
      B3 C#4 D4 E4 F#4 D4 F#4+B4 | F4 C#4 F4+A4 | E4 C4 E4+G4
      B3 C#4 D4 E4 F#4 D4 F#4 B4 A4 F#4 D4 F#4 A4~4
      B4 C#5 D5 E5 F#5 D5 F#5+B5 | F5 C#5 F5+A5 | E5 C5 E5+G5 | B4+F#5
    `,
  },
];

export const SONGS: readonly Song[] = DEFINITIONS.map(({ notes, ...song }) => ({
  ...song,
  beats: parseBeats(notes),
}));

export function getSong(id: string): Song | undefined {
  return SONGS.find((song) => song.id === id);
}

/** Tiles per minute at 1.0x speed. */
export function songBpm(song: Song): number {
  return Math.round((song.speed / TILE_HEIGHT) * 60);
}

/** Total tile rows in one lap of the song. */
export function songRows(song: Song): number {
  return song.beats.reduce((sum, beat) => sum + (beat.type === 'hold' ? beat.rows : 1), 0);
}

/** Seconds one lap takes at 1.0x speed. */
export function songSeconds(song: Song): number {
  return (songRows(song) * TILE_HEIGHT) / song.speed;
}

export function songFeatures(song: Song): { doubles: boolean; holds: boolean } {
  return {
    doubles: song.beats.some((beat) => beat.type === 'double'),
    holds: song.beats.some((beat) => beat.type === 'hold'),
  };
}
