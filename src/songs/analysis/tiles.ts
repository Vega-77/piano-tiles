import { MAX_HOLD_ROWS, MIN_HOLD_ROWS } from '../../config';
import { percentile } from './dsp';
import { ENV_LAG, FPS, type Features } from './features';
import { AnalysisError, type Grid, rowLength } from './grid';

export type Density = 'easy' | 'normal' | 'hard';
export const DENSITIES: readonly Density[] = ['easy', 'normal', 'hard'];

interface Settings {
  /** Fewest rows between two tiles. */
  gap: number;
  /** Share of the rows that get a tile. */
  fraction: number;
  /** At most this share of the tiles is a double / a hold. */
  doubles: number;
  holds: number;
}

export const DENSITY: Record<Density, Settings> = {
  easy: { gap: 2, fraction: 0.28, doubles: 0.0, holds: 0.12 },
  normal: { gap: 2, fraction: 0.4, doubles: 0.03, holds: 0.12 },
  hard: { gap: 1, fraction: 0.52, doubles: 0.06, holds: 0.1 },
};

/** Taps per second no chart is allowed to ask for. */
const MAX_TAP_RATE = 4.5;
export const MIN_TILES = 20;

export type TileKind = 'tap' | 'double' | 'hold';
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

/** Picks which rows get a tile, and which of those are holds and doubles. */
export function chooseTiles(features: Features, grid: Grid, rows: number, level: Density): Tiles {
  const settings = DENSITY[level];
  const { strength, agree } = slotStrengths(features, grid, rows);
  const loudness = rowLoudness(features, grid, rows);

  const gap = Math.max(settings.gap, Math.ceil(grid.rate / MAX_TAP_RATE - 1e-9));
  const active = Array.from(strength).filter((value) => value > 0);
  if (active.length === 0) throw new AnalysisError("Couldn't find any beats in that audio.");
  const floor = 0.12 * percentile(active, 98);
  const wanted = Math.trunc(settings.fraction * rows);

  // The strongest rows first (the earlier row, if two are equally strong), each blocking its neighbours.
  const order = Array.from({ length: rows }, (_, k) => k).sort((a, b) => strength[b] - strength[a] || a - b);
  const blocked = new Uint8Array(rows);
  const chosen: number[] = [];
  for (const k of order) {
    if (chosen.length >= wanted || strength[k] < floor) break;
    if (blocked[k]) continue;
    chosen.push(k);
    blocked.fill(1, Math.max(0, k - gap + 1), Math.min(rows, k + gap));
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
  for (const { k, length } of ranked) {
    if (holds >= holdCap) break;
    if (length >= MIN_HOLD_ROWS && Math.abs(k - lastHold) >= 8) {
      tokens.set(k, { kind: 'hold', rows: length });
      holds++;
      lastHold = k;
    }
  }

  // Doubles: the hardest hits, where the low, middle and high of the sound all agree.
  const doubleCap = Math.trunc(settings.doubles * chosen.length);
  if (doubleCap > 0) {
    const strong = chosen.filter((k) => tokens.get(k)!.kind === 'tap' && agree[k] >= 2).sort((a, b) => strength[b] - strength[a]);
    for (const k of strong.slice(0, doubleCap)) {
      const crowded = [k - 1, k + 1].some((j) => tokens.has(j));
      if (!crowded) tokens.set(k, { kind: 'double', rows: 1 });
    }
  }
  return { tokens, rows };
}

/** The tiles in the game's notation: x tap, xx double, x~3 hold, . rest; eight rows to a line. */
export function formatTiles(chart: Tiles): string {
  const lines: string[] = [];
  let line: string[] = [];
  let row = 0;
  while (row < chart.rows) {
    const tile = chart.tokens.get(row);
    line.push(!tile ? '.' : tile.kind === 'tap' ? 'x' : tile.kind === 'double' ? 'xx' : `x~${tile.rows}`);
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

/** 1 (beginner) to 5 (expert), from how fast the tiles come and how many there are. */
export function difficultyOf(peak: number, average: number, doubles: number): 1 | 2 | 3 | 4 | 5 {
  const load = 0.5 * peak + 0.5 * average * 1.8;
  const value = 1 + (load - 1.6) / 0.55 + (doubles > 0 ? 0.3 : 0);
  return Math.min(5, Math.max(1, Math.floor(value + 0.5))) as 1 | 2 | 3 | 4 | 5;
}
