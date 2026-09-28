export type GameStatus = 'menu' | 'playing' | 'gameover';

export interface GameState {
  status: GameStatus;
  score: number;
  /** Starts at 1 and increases by SPEED_STEP every TILES_PER_SPEED_STEP tiles. */
  speedMultiplier: number;
  /** Best score for the current song. */
  highScore: number;
  songId: string;
  /** 0–1: how far through the current lap of the song. */
  progress: number;
}

export type TileKind = 'tap' | 'hold';

/** Progress of a hold tile: press it, keep holding until its top edge reaches `line`. */
export interface HoldState {
  phase: 'pending' | 'holding' | 'done';
  /** Which pointer or key is holding it. */
  pointer: string | null;
  /** Y (percent of board height) the tile's top edge must reach before letting go. */
  line: number;
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
  /** Tiles that must be cleared together (a double) share a beat. */
  beat: number;
  /** Pitch this tile plays, in Hz. */
  freq: number;
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
  /** Fall speed at 1.0x, in percent of board height per second. */
  speed: number;
  /** Theme colours (HSL hues) for tiles and background. */
  hue: number;
  hue2: number;
  beats: readonly BeatSpec[];
}
