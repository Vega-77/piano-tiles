export type GameStatus = 'menu' | 'playing' | 'gameover';

export interface GameState {
  status: GameStatus;
  score: number;
  /** How much faster tiles fall than on the first lap of the song: LAP_SPEED_FACTOR ** lap. */
  speedMultiplier: number;
  /** Best score for the current song. */
  highScore: number;
  songId: string;
  /** 0–1: how far through the current lap of the song. */
  progress: number;
  /** Consecutive perfect hits. */
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

/** A hold tile is pressed at its head and held until its tail reaches the bar. */
export interface HoldState {
  phase: 'pending' | 'holding' | 'done';
  /** Which pointer or key is holding it. */
  pointer: string | null;
  /** Song time (seconds) when the tail reaches the bar: hold until then. */
  end: number;
}

export interface Tile {
  id: string;
  /** 0, 1, 2 or 3 */
  lane: number;
  /** Top edge of the tile as a percentage of board height (0 = top, 100 = bottom). */
  yPos: number;
  /** Tap tiles: tapped. Hold tiles: pressed *and* held to the end. */
  isHit: boolean;
  kind: TileKind;
  /** Height in rows: 1 for taps, 2–4 for holds. */
  rows: number;
  /** Index of the beat this tile belongs to, counting across laps. Doubles share one. */
  beat: number;
  /** Pitch this tile's note plays, in Hz. */
  freq: number;
  /** Row (counting across laps) whose bottom edge is this tile's head; it is at the bar when the scroll reaches it. */
  start: number;
  /** Song time (seconds) when the head reaches the bar: the ideal moment to tap. */
  time: number;
  hold: HoldState | null;
}

/** One step of a song, before it is given lanes and a position. */
export type BeatSpec =
  | { type: 'tap'; freq: number }
  /** Two tiles in the same row with exactly one lane between them. */
  | { type: 'double'; freqs: [number, number] }
  | { type: 'hold'; freq: number; rows: number };

export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface Song {
  id: string;
  title: string;
  composer: string;
  description: string;
  difficulty: Difficulty;
  /** Fall speed (and tempo) on the first lap, in percent of board height per second. */
  speed: number;
  /** Theme colours (HSL hues) for tiles and background. */
  hue: number;
  hue2: number;
  beats: readonly BeatSpec[];
}
