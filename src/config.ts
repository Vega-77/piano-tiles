export const LANES = 4;

/** Height of one tile row, as a percentage of board height. */
export const TILE_HEIGHT = 25;

/** Fall speed at 1.0x, in percent of board height per second (2 rows/s). */
export const BASE_SPEED = 50;

export const SPEED_STEP = 0.05;
export const TILES_PER_SPEED_STEP = 50;

/** Y position of the first tile; the row below it is left blank as a runway. */
export const FIRST_TILE_Y = 50;

/** Longest simulated frame, so a backgrounded tab doesn't teleport the tiles. */
export const MAX_FRAME_DT = 0.05;

/** Delay before the game-over panel appears, so the player can see the mistake. */
export const GAME_OVER_REVEAL_MS = 700;
