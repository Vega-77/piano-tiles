export type GameStatus = 'menu' | 'playing' | 'gameover';

export interface GameState {
  status: GameStatus;
  score: number;
  /** Starts at 1 and increases by SPEED_STEP every TILES_PER_SPEED_STEP tiles. */
  speedMultiplier: number;
  highScore: number;
}

export interface Tile {
  id: string;
  /** 0, 1, 2 or 3 */
  lane: number;
  /** Top edge of the tile as a percentage of board height (0 = top, 100 = bottom). */
  yPos: number;
  isHit: boolean;
}
