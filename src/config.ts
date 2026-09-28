export const LANES = 4;

/** Height of one tile row, as a percentage of board height. */
export const TILE_HEIGHT = 25;

/**
 * The timing bar: where a tile's leading (bottom) edge should be at the moment it is
 * tapped, as a percentage of board height.
 */
export const BAR_Y = 86;

/** Rows of empty board that scroll past before the first tile reaches the bar. */
export const LEAD_ROWS = 4;

/**
 * Each time the song finishes, tiles fall (and the music plays) this many times faster
 * than on the previous lap: lap 0 = 1x, lap 1 = 1.3x, lap 2 = 1.69x, and so on.
 */
export const LAP_SPEED_FACTOR = 1.3;

// Timing windows: seconds either side of the moment a tile reaches the bar.
export const PERFECT_WINDOW = 0.08;
export const GOOD_WINDOW = 0.16;
/** A tile that is still untapped this long after reaching the bar is missed. */
export const MISS_AFTER = 0.32;

/** Base points per tile for each judgment, before the chain multiplier. */
export const POINTS = { perfect: 100, good: 60, ok: 25 } as const;
/** Extra base points for holding a hold tile all the way to its end. */
export const HOLD_BONUS = 50;

/** Every COMBO_STEP perfects in a row raises the points multiplier by one... */
export const COMBO_STEP = 8;
/** ...up to this cap. */
export const COMBO_MAX_MULTIPLIER = 8;

/** How early (seconds) a hold may be let go before its end without failing. */
export const HOLD_RELEASE_TOLERANCE = 0.15;

/** A repeat press on a lane cleared this recently is ignored rather than punished. */
export const DOUBLE_TAP_GUARD = 0.12;

/** How far ahead (seconds) the music is scheduled on the audio clock. */
export const NOTE_LOOKAHEAD = 0.5;

/** Hold tiles are 2–4 rows long. */
export const MIN_HOLD_ROWS = 2;
export const MAX_HOLD_ROWS = 4;

/** Delay before the game-over panel appears, so the player can see the mistake. */
export const GAME_OVER_REVEAL_MS = 900;
