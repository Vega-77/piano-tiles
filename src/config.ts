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

/**
 * A run that has failed can be picked up again, once, from the start of the bar it fell in, after a count-in. That costs
 * this share of the score (the rest is kept) and the chain: the points multiplier starts over from ×1.
 */
export const CONTINUE_SCORE_COST = 0.25;

// Timing windows: seconds either side of the moment a tile is centred on the bar.
export const PERFECT_WINDOW = 0.1;
export const GOOD_WINDOW = 0.18;
/**
 * The furthest a tap may be from the bar and still count. Tap earlier than this and the tile doesn't line up with the
 * bar (a mistake); leave a tile later than this and it is missed (a mistake too). Neither ends the run by itself: each
 * breaks the chain and costs a life (see `LIVES`).
 */
export const OK_WINDOW = 0.25;

/**
 * A run has this many lives. A mistake (a tile missed, a tap too early, a tap in a lane with no tile) breaks the chain and
 * costs one; when the last is gone the run is over. Without a limit nothing could ever end a run.
 */
export const LIVES = 3;
/** Mistakes closer together than this (seconds) are one mistake as far as lives go, so a fumbled tile costs one life. */
export const STRIKE_GRACE = 0.3;
/** Every this many perfects in a row wins a life back (never above `LIVES`). */
export const LIFE_CHAIN = 20;
/**
 * Whether songs have double holds. They are switched off for now: they did not make the game any better to play, so the
 * analyser lays none and a chart that has one (`xx~3`) is played with an ordinary hold of the same length, which keeps
 * every row, and so all the timing, where it was. Everything else about them is still there to switch back on.
 */
export const DOUBLE_HOLDS = false;
/**
 * A double hold takes two fingers down at once, and it is the tile that players find hardest to get to in time, so
 * both halves may be grabbed this much later than the bar (still as an OK). Early, they are as strict as any tile.
 */
export const DOUBLE_HOLD_LATE_WINDOW = 0.5;

/** Base points per tile for each judgment, before the chain multiplier. */
export const POINTS = { perfect: 100, good: 60, ok: 25 } as const;

/**
 * A hold tile pays out in ticks, one every half row for as long as it is held. Letting go
 * early just stops the ticks; it never ends the game.
 */
export const HOLD_TICK_POINTS = 10;

/**
 * Every COMBO_STEP perfects in a row raises the points multiplier by one... Anything but a perfect breaks the chain: a
 * tap that is early or late (a good or an OK) as much as a mistake.
 */
export const COMBO_STEP = 5;
/** ...up to this cap. */
export const COMBO_MAX_MULTIPLIER = 8;

/**
 * The pairs of lanes a double can fall in, one of them picked at random each time: never neighbours. Two with a lane between
 * them (0 and 2, 1 and 3), and the two outside lanes (0 and 3), one for each thumb.
 */
export const DOUBLE_LANES: readonly (readonly [number, number])[] = [[0, 2], [1, 3], [0, 3]];

/** A repeat press on a lane cleared this recently is ignored rather than punished. */
export const DOUBLE_TAP_GUARD = 0.12;

/** How far ahead (seconds) the music is scheduled on the audio clock. */
export const NOTE_LOOKAHEAD = 0.5;

/** Hold tiles are 2–4 rows long. */
export const MIN_HOLD_ROWS = 2;
export const MAX_HOLD_ROWS = 4;

/** Delay before the game-over panel appears, so the player can see the mistake. */
export const GAME_OVER_REVEAL_MS = 900;
