export const LANES = 4;

/** Height of one tile row, as a percentage of board height. */
export const TILE_HEIGHT = 25;

/** Top of the blank row under the first beat, which gives the player a runway. */
export const RUNWAY_TOP = 100 - TILE_HEIGHT;

export const SPEED_STEP = 0.05;
export const TILES_PER_SPEED_STEP = 50;

/** Longest simulated frame, so a backgrounded tab doesn't teleport the tiles. */
export const MAX_FRAME_DT = 0.05;

/** How far (percent of board height) before the end of a hold tile it may be let go. */
export const HOLD_TOLERANCE = 4;

/** Hold tiles are 2–4 rows long. */
export const MIN_HOLD_ROWS = 2;
export const MAX_HOLD_ROWS = 4;

/** Delay before the game-over panel appears, so the player can see the mistake. */
export const GAME_OVER_REVEAL_MS = 900;
