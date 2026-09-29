import { DOUBLE_HOLDS, MAX_HOLD_ROWS, MIN_HOLD_ROWS } from '../../config';
import { percentile } from './dsp';
import { ENV_LAG, FPS, type Features } from './features';
import { AnalysisError, type Grid, rowLength } from './grid';

export type Density = 'easy' | 'medium' | 'hard';
export const DENSITIES: readonly Density[] = ['easy', 'medium', 'hard'];
/** What a song is charted at when nothing else is asked for. */
export const DEFAULT_DENSITY: Density = 'medium';

/**
 * A level as it was saved with a chart, read back. Charts saved before the levels moved up one
 * called what is now Easy "normal"; anything unrecognised is the default.
 */
export function densityFrom(saved: unknown): Density {
  if (saved === 'normal') return 'easy';
  return DENSITIES.find((level) => level === saved) ?? DEFAULT_DENSITY;
}

interface Settings {
  /** Fewest rows between two tiles. */
  gap: number;
  /** Share of the rows that get a tile. */
  fraction: number;
  /** At most this share of the tiles is a double / a hold. */
  doubles: number;
  holds: number;
  /** This share of the holds is turned into a double hold (at least one, if there are two holds). */
  doubleHolds: number;
}

export const DENSITY: Record<Density, Settings> = {
  easy: { gap: 2, fraction: 0.4, doubles: 0.12, holds: 0.12, doubleHolds: 0.25 },
  medium: { gap: 1, fraction: 0.52, doubles: 0.2, holds: 0.1, doubleHolds: 0.3 },
  hard: { gap: 1, fraction: 0.66, doubles: 0.28, holds: 0.1, doubleHolds: 0.4 },
};

/** Fewest rows between two double holds: one is a lot to ask, and they are best not to come in a run. */
const DOUBLE_HOLD_SPACING = 16;

/** Taps per second no chart is allowed to ask for. */
const MAX_TAP_RATE = 4.5;
export const MIN_TILES = 20;

/** The song is cut into stretches of this many beats (two bars), each promised some tiles. */
const WINDOW_BEATS = 8;
/**
 * The share of the average tile density that every stretch with something going on is promised,
 * however much louder the rest of the song is. Without it the loud hits of a chorus would use up
 * all the tiles, and a verse would be left nearly bare.
 */
const WINDOW_SHARE = 0.6;
/** Within a stretch, hits weaker than this share of its strongest one are just noise. */
const WINDOW_FLOOR = 0.15;
/**
 * A stretch whose strongest hit is under this share of the loud hits is left bare: it is a silence
 * or a fade, and the hits the analyser hears there are only the noise in the recording (about a
 * tenth of a loud hit, where a quiet verse is nearer four tenths).
 */
const AUDIBLE = 0.15;
/** How much more a hit on the beat is worth than one between beats when the two compete for a tile. */
const BEAT_BONUS = 1.2;

export type TileKind = 'tap' | 'double' | 'hold' | 'doublehold';
export interface Tile {
  kind: TileKind;
  rows: number;
}
export interface Tiles {
  /** Row a tile starts on → the tile. */
  tokens: Map<number, Tile>;
  rows: number;
}

/**
 * Onset strength at each row of the grid, and how many frequency bands agree there (0–3).
 *
 * Each envelope frame counts towards the nearest row, less so the further it is from it, so a
 * row is only strong when there really is a hit close to it.
 */
function slotStrengths(features: Features, grid: Grid, rows: number): { strength: Float64Array; agree: Float64Array } {
  const row = rowLength(grid);
  const frames = features.env.length;
  const slot = new Int32Array(frames);
  const weight = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const time = i / FPS + ENV_LAG;
    const k = Math.round((time - grid.phase) / row);
    const distance = Math.abs(time - grid.phase - k * row) / (0.5 * row);
    slot[i] = k;
    weight[i] = 1 - 0.7 * Math.min(distance, 1) ** 2;
  }

  const slots = (values: Float64Array) => {
    const out = new Float64Array(rows);
    for (let i = 0; i < frames; i++) {
      const k = slot[i];
      if (k >= 0 && k < rows) out[k] = Math.max(out[k], values[i] * weight[i]);
    }
    return out;
  };

  const strength = slots(features.env);
  const agree = new Float64Array(rows);
  for (const band of [features.low, features.mid, features.high]) {
    const s = slots(band);
    const positive = Array.from(s).filter((value) => value > 0);
    const scale = positive.length > 0 ? percentile(positive, 90) : 1;
    for (let k = 0; k < rows; k++) if (s[k] >= 0.5 * scale) agree[k] += 1;
  }
  return { strength, agree };
}

/** Mean loudness within each row of the grid. */
function rowLoudness(features: Features, grid: Grid, rows: number): Float64Array {
  const row = rowLength(grid);
  const total = new Float64Array(rows);
  const count = new Float64Array(rows);
  for (let i = 0; i < features.rms.length; i++) {
    const time = i / FPS + ENV_LAG;
    const k = Math.floor((time - grid.phase) / row + 0.5);
    if (k >= 0 && k < rows) {
      total[k] += features.rms[i];
      count[k] += 1;
    }
  }
  for (let k = 0; k < rows; k++) total[k] /= Math.max(count[k], 1);
  return total;
}

/** Which of a beat's rows (0 to rowsPerBeat - 1) the hits are strongest on. */
function beatResidue(strength: Float64Array, rowsPerBeat: number): number {
  const totals = new Float64Array(rowsPerBeat);
  for (let k = 0; k < strength.length; k++) totals[k % rowsPerBeat] += strength[k];
  let beat = 0;
  for (let i = 1; i < rowsPerBeat; i++) if (totals[i] > totals[beat]) beat = i;
  return beat;
}

/** Which rows fall on the beat: the ones a whole number of beats from the row where the hits are strongest. */
function onTheBeat(strength: Float64Array, rowsPerBeat: number): Uint8Array {
  const beat = beatResidue(strength, rowsPerBeat);
  return Uint8Array.from(strength, (_, k) => (k % rowsPerBeat === beat ? 1 : 0));
}

/**
 * How many rows after the grid's row 0 the first beat falls (0 to rowsPerBeat - 1). The grid only
 * knows where its rows are, not which of them are beats; the game counts a song in on the beat, so
 * the grid is moved to start on one.
 */
export function beatOffset(features: Features, grid: Grid, rowsPerBeat: number): number {
  if (rowsPerBeat <= 1) return 0;
  const rows = Math.max(1, Math.ceil((features.duration - grid.phase) * grid.rate - 1e-9));
  return beatResidue(slotStrengths(features, grid, rows).strength, rowsPerBeat);
}

/**
 * Picks which rows get a tile, and which of those are holds and doubles.
 *
 * The tiles go on the strongest hits, in two rounds. First every stretch of the song is given its
 * share (WINDOW_SHARE) of the average density, on the strongest hits within that stretch, so a
 * quiet verse gets tiles on the hits that are strong for a verse. Then what is left of the total
 * goes to the strongest hits anywhere, which is where a chorus gets its extra.
 */
export function chooseTiles(features: Features, grid: Grid, rows: number, level: Density, rowsPerBeat: number): Tiles {
  const settings = DENSITY[level];
  const { strength, agree } = slotStrengths(features, grid, rows);
  const loudness = rowLoudness(features, grid, rows);

  const gap = Math.max(settings.gap, Math.ceil(grid.rate / MAX_TAP_RATE - 1e-9));
  const active = Array.from(strength).filter((value) => value > 0);
  if (active.length === 0) throw new AnalysisError("Couldn't find any beats in that audio.");
  const loud = percentile(active, 98);
  const floor = 0.12 * loud;
  const wanted = Math.trunc(settings.fraction * rows);

  const beat = onTheBeat(strength, rowsPerBeat);
  const worth = Float64Array.from(strength, (value, k) => value * (beat[k] ? BEAT_BONUS : 1));
  // Best first (the earlier row, if two are worth the same).
  const best = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => from + i).sort((a, b) => worth[b] - worth[a] || a - b);

  const blocked = new Uint8Array(rows);
  const chosen: number[] = [];
  const take = (k: number) => {
    chosen.push(k);
    blocked.fill(1, Math.max(0, k - gap + 1), Math.min(rows, k + gap)); // (each tile blocks its neighbours)
  };

  const size = WINDOW_BEATS * rowsPerBeat;
  for (let from = 0; from < rows; from += size) {
    const to = Math.min(rows, from + size);
    let peak = 0;
    for (let k = from; k < to; k++) peak = Math.max(peak, strength[k]);
    if (peak < AUDIBLE * loud) continue;
    const share = Math.round(WINDOW_SHARE * settings.fraction * (to - from));
    let taken = 0;
    for (const k of best(from, to)) {
      if (taken >= share || chosen.length >= wanted) break;
      if (blocked[k] || strength[k] < WINDOW_FLOOR * peak) continue;
      take(k);
      taken++;
    }
  }

  for (const k of best(0, rows)) {
    if (chosen.length >= wanted) break;
    if (!blocked[k] && strength[k] >= floor) take(k);
  }
  chosen.sort((a, b) => a - b);
  if (chosen.length < MIN_TILES) {
    throw new AnalysisError("Couldn't find enough beats to make a chart from. Try giving the tempo by hand.");
  }

  const tokens = new Map<number, Tile>(chosen.map((k) => [k, { kind: 'tap', rows: 1 }]));
  const following = new Map(chosen.map((k, i) => [k, i + 1 < chosen.length ? chosen[i + 1] : rows]));

  // Holds: a hit followed by rows of sustained sound with no other hit in them.
  const sustain = (k: number): { length: number; level: number } => {
    const room = Math.min(MAX_HOLD_ROWS, following.get(k)! - k);
    const peak = loudness[k] || 1e-9;
    let best = { length: 0, level: 0 };
    for (let length = MIN_HOLD_ROWS; length <= room; length++) {
      let quietest = Infinity;
      let quiet = true;
      for (let j = k + 1; j < k + length; j++) {
        quietest = Math.min(quietest, loudness[j]);
        if (!(strength[j] < 0.5 * strength[k])) quiet = false;
      }
      const level = quietest / peak;
      if (level >= 0.6 && quiet) best = { length, level };
    }
    return best;
  };

  let holds = 0;
  let lastHold = -100;
  const holdCap = Math.trunc(settings.holds * chosen.length);
  const ranked = chosen.map((k) => ({ k, ...sustain(k) })).sort((a, b) => b.level - a.level);
  const held: number[] = [];
  for (const { k, length } of ranked) {
    if (holds >= holdCap) break;
    if (length >= MIN_HOLD_ROWS && Math.abs(k - lastHold) >= 8) {
      tokens.set(k, { kind: 'hold', rows: length });
      held.push(k);
      holds++;
      lastHold = k;
    }
  }

  // Double holds: some of the holds, on the hits the most of the sound agrees on, kept well apart.
  const doubleRows = new Uint8Array(rows + 1); // (the rows a double or a double hold covers)
  const doubleHoldCap = !DOUBLE_HOLDS || held.length < 2 ? 0 : Math.max(1, Math.round(settings.doubleHolds * held.length));
  const doubleHolds: number[] = [];
  for (const k of [...held].sort((a, b) => agree[b] - agree[a] || strength[b] - strength[a] || a - b)) {
    if (doubleHolds.length >= doubleHoldCap) break;
    if (doubleHolds.some((other) => Math.abs(other - k) < DOUBLE_HOLD_SPACING)) continue;
    const { rows: length } = tokens.get(k)!;
    tokens.set(k, { kind: 'doublehold', rows: length });
    doubleRows.fill(1, k, k + length);
    doubleHolds.push(k);
  }

  // Doubles: taps on the hits that the most of the low, middle and high of the sound agree on. Every
  // stretch of the song takes its turn, best hit first, so they are spread through the song and
  // not all in the loudest part.
  const doubleCap = Math.trunc(settings.doubles * chosen.length);
  if (doubleCap > 0) {
    const byStretch = new Map<number, number[]>();
    for (const k of chosen) {
      if (tokens.get(k)!.kind !== 'tap') continue;
      const stretch = Math.trunc(k / size);
      byStretch.set(stretch, [...(byStretch.get(stretch) ?? []), k]);
    }
    const turns = [...byStretch.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, taps]) => taps.sort((a, b) => agree[b] - agree[a] || strength[b] - strength[a]));
    let doubles = 0;
    while (doubles < doubleCap && turns.some((taps) => taps.length > 0)) {
      for (const taps of turns) {
        if (doubles >= doubleCap) break;
        for (let k = taps.shift(); k !== undefined; k = taps.shift()) {
          if (doubleRows[k - 1] || doubleRows[k + 1]) continue; // (never two rows of doubles in a row)
          tokens.set(k, { kind: 'double', rows: 1 });
          doubleRows[k] = 1;
          doubles++;
          break;
        }
      }
    }
  }
  return { tokens, rows };
}

/** The tiles in the game's notation: x tap, xx double, x~3 hold, xx~3 double hold, . rest; eight rows to a line. */
export function formatTiles(chart: Tiles): string {
  const lines: string[] = [];
  let line: string[] = [];
  let row = 0;
  while (row < chart.rows) {
    const tile = chart.tokens.get(row);
    line.push(!tile ? '.' : tile.kind === 'tap' ? 'x' : tile.kind === 'double' ? 'xx' : `${tile.kind === 'hold' ? 'x' : 'xx'}~${tile.rows}`);
    row += tile?.rows ?? 1;
    if (row % 8 === 0 || row >= chart.rows) {
      lines.push(line.join(' '));
      line = [];
    }
  }
  if (line.length > 0) lines.push(line.join(' '));
  return lines.join('\n');
}

/** Tiles per second at the busiest moment (the 95th percentile of the rate between tiles) and on average. */
export function describe(chart: Tiles, grid: Grid, duration: number): { peak: number; average: number } {
  const starts = [...chart.tokens.keys()].sort((a, b) => a - b);
  const row = rowLength(grid);
  const rates: number[] = [];
  for (let i = 1; i < starts.length; i++) rates.push(1 / ((starts[i] - starts[i - 1]) * row));
  return { peak: rates.length > 0 ? percentile(rates, 95) : 0, average: starts.length / duration };
}

/** 1 (beginner) to 5 (expert), from how fast the tiles come, how many there are and how many are doubles (0–1). */
export function difficultyOf(peak: number, average: number, doubleShare: number): 1 | 2 | 3 | 4 | 5 {
  const load = 0.5 * peak + 0.5 * average * 1.8;
  const value = 1 + (load - 1.6) / 0.55 + 1.5 * doubleShare;
  return Math.min(5, Math.max(1, Math.floor(value + 0.5))) as 1 | 2 | 3 | 4 | 5;
}
