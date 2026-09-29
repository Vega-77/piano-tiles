export const LANES = 4;

/** Height of one tile row, as a percentage of board height. */
export const TILE_HEIGHT = 25;

/**
 * The timing bar, as a percentage of board height. It marks where the *centre* of a tile
 * (the centre of its lowest row, for a hold tile) should be at the moment it is tapped.
 */
export const BAR_Y = 80;

/**
 * Each time the song finishes, tiles fall (and the music plays) this much faster than at the
 * start: lap 0 = 1x, lap 1 = 1.2x, lap 2 = 1.4x, lap 3 = 1.6x, and so on. The step is added to
 * the first lap's speed each time; it doesn't compound.
 */
export const LAP_SPEED_STEP = 0.2;

/**
 * After every lap the board empties for at least this long (seconds, at the new speed) so the
 * player can take in the speed jump, then a count-in of COUNT_IN_BEATS beats leads into the next
 * lap. The first lap starts with the same count-in, and so does the game after a pause.
 */
export const LAP_REST_SECONDS = 1.5;
export const COUNT_IN_BEATS = 4;

// Timing windows: seconds either side of the moment a tile is centred on the bar.
export const PERFECT_WINDOW = 0.1;
export const GOOD_WINDOW = 0.18;
/**
 * The furthest a tap may be from the bar and still count. Tap earlier than this and the tile
 * doesn't line up with the bar: the game ends. Leave a tile later than this and it's missed.
 */
export const OK_WINDOW = 0.25;

/** Base points per tile for each judgment, before the chain multiplier. */
export const POINTS = { perfect: 100, good: 60, ok: 25 } as const;

/**
 * A hold tile pays out in ticks, one every half row for as long as it is held. Letting go
 * early just stops the ticks; it never ends the game.
 */
export const HOLD_TICK_POINTS = 10;

/**
 * Every COMBO_STEP perfects in a row raises the points multiplier by one... A good hit keeps the
 * chain going without adding to it; anything less breaks it.
 */
export const COMBO_STEP = 5;
/** ...up to this cap. */
export const COMBO_MAX_MULTIPLIER = 8;

/** A repeat press on a lane cleared this recently is ignored rather than punished. */
export const DOUBLE_TAP_GUARD = 0.12;

/** How far ahead (seconds) the music is scheduled on the audio clock. */
export const NOTE_LOOKAHEAD = 0.5;

/** Hold tiles are 2–4 rows long. */
export const MIN_HOLD_ROWS = 2;
export const MAX_HOLD_ROWS = 4;

/** Delay before the game-over panel appears, so the player can see the mistake. */
export const GAME_OVER_REVEAL_MS = 900;
