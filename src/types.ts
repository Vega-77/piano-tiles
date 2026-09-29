export type GameStatus = 'menu' | 'playing' | 'gameover';

export interface GameState {
  status: GameStatus;
  score: number;
  /** How much faster tiles fall than on the first lap of the song: 1 + LAP_SPEED_STEP * lap. */
  speedMultiplier: number;
  /** Best score for the current song. */
  highScore: number;
  songId: string;
  /** 0–1: how far through the current lap of the song. */
  progress: number;
  /** The chain: perfect hits in a row (a good hit keeps it going without adding to it). */
  combo: number;
  /** Points multiplier earned by the current chain of perfects. */
  comboMultiplier: number;
  /** Completed laps of the song; each one makes the tiles faster. */
  lap: number;
  paused: boolean;
}

export type TileKind = 'tap' | 'hold';

/** How close to the bar a tile was when tapped. */
export type Judgment = 'perfect' | 'good' | 'ok';

/**
 * A hold tile is pressed as its head reaches the bar and pays out in ticks while it is held.
 * Letting go early just stops the ticks.
 */
export interface HoldState {
  phase: 'pending' | 'holding' | 'done';
  /** Which pointer or key is holding it. */
  pointer: string | null;
  /** Song time (seconds) when the tile's far end reaches the bar and the hold is complete. */
  end: number;
  /** Ticks that will pay out over the hold, and how many have been passed so far. */
  totalTicks: number;
  ticks: number;
  /** Points earned from ticks so far. */
  earned: number;
}

export interface Tile {
  id: string;
  /** 0, 1, 2 or 3 */
  lane: number;
  /** Top edge of the tile as a percentage of board height (0 = top, 100 = bottom). */
  yPos: number;
  /** Tap tiles: tapped. Hold tiles: pressed and then either finished or let go. */
  isHit: boolean;
  kind: TileKind;
  /** Height in rows: 1 for taps, 2–4 for holds. */
  rows: number;
  /** Index of the beat this tile belongs to, counting across laps. Doubles share one. */
  beat: number;
  /** Pitch this tile's note plays, in Hz. */
  freq: number;
  /** Row (counting across laps) where this tile's head begins; its head is centred on the bar when the scroll reaches it. */
  start: number;
  /** Song time (seconds) when the head is centred on the bar: the ideal moment to tap. */
  time: number;
  hold: HoldState | null;
}

/** One step of a song's melody, before it is given lanes and a position. */
export type BeatSpec =
  | { type: 'tap'; freq: number }
  /** Two tiles in the same row with exactly one lane between them. */
  | { type: 'double'; freqs: [number, number] }
  | { type: 'hold'; freq: number; rows: number }
  /** Two hold tiles in the same row with exactly one lane between them: both are pressed and held. */
  | { type: 'doublehold'; freqs: [number, number]; rows: number }
  /** A gap: nothing to tap for this many rows. */
  | { type: 'rest'; rows: number };

/**
 * One row-long slot of the backing track, in the song's own row grid. Row lengths are turned
 * into seconds by the tempo, so the whole track speeds up with the tiles.
 */
export type MusicEvent =
  | { kind: 'melody'; freq: number; rows?: number }
  | { kind: 'kick' }
  | { kind: 'snare'; soft?: boolean }
  | { kind: 'hat'; soft?: boolean }
  | { kind: 'bass'; freq: number; rows: number }
  | { kind: 'chord'; freqs: number[]; rows: number; pad?: boolean };

/**
 * A drum-and-bass pattern for one bar, one character per row.
 *   kick / snare / hat: 'x' = hit, 'o' = soft hit, '.' = nothing
 *   bass:  '1' = the chord's root, '5' = its fifth, '8' = its octave, '.' = nothing (a note rings until the next)
 *   chord: 'x' = a short chord stab, '.' = nothing
 */
export interface Groove {
  kick: string;
  snare: string;
  hat: string;
  bass: string;
  chord: string;
  /** Hold the bar's chord as a soft pad underneath. */
  pad: boolean;
}

export type Difficulty = 1 | 2 | 3 | 4 | 5;

/**
 * A real recording that plays under the tiles instead of the synthesised backing track. The
 * song's rows are the recording's beat grid: row 0 falls `offset` seconds into the audio, and
 * every row lasts 60 / (bpm × rowsPerBeat) seconds.
 */
export interface Recording {
  /** Where to fetch the audio from. */
  url: string;
  /** Seconds into the audio at which row 0 falls (the first beat: under a beat), and negative if the audio should start late. */
  offset: number;
  /** Length of the audio in seconds. */
  duration: number;
  /** Where in the audio a lap stops (seconds), if the song is longer than a lap may be. Missing: play to the end. */
  end?: number;
}

/** Whether a song is in the catalogue everybody plays: not yet (a draft), changed here since, or as published. */
export type Publication = 'draft' | 'changed' | 'live';

/** What a song made from a recording remembers about how it was charted, for the tuning panel. */
export interface ImportInfo {
  /** The hand-set sync correction, in seconds (positive if the tiles land early against the music). */
  nudge: number;
  /** Whether the tempo was typed in rather than detected. */
  manualBpm: boolean;
  /** How busy the chart was asked to be. */
  level: 'easy' | 'medium' | 'hard';
  /** How long a lap was allowed to be. */
  length: 'short' | 'medium' | 'long';
  /** 0–1: how well the detected beats fit the grid, when the analyser said. */
  confidence?: number;
  warnings: readonly string[];
  publication: Publication;
}

export interface Song {
  id: string;
  title: string;
  composer: string;
  description: string;
  difficulty: Difficulty;
  /** Beats per minute, and how many rows (the smallest step of the song) make up one beat. */
  bpm: number;
  rowsPerBeat: number;
  rowsPerBar: number;
  /** Fall speed on the first lap, in percent of board height per second (derived from bpm). */
  speed: number;
  /** Theme colours (HSL hues) for tiles and background. */
  hue: number;
  hue2: number;
  /** The tapping part: rows of melody, with gaps. */
  beats: readonly BeatSpec[];
  /** The whole song, row by row: melody plus drums, bass and chords. Empty for recorded songs. */
  track: readonly (readonly MusicEvent[])[];
  /** Set on imported songs: the audio that plays instead of `track`. */
  recording?: Recording;
  /** Set on imported songs, along with `recording`. */
  imported?: ImportInfo;
}
