import { ImportError } from '../errors';
import { clamp, modulo, percentile } from './dsp';
import { ENV_LAG, FPS, type Features } from './features';

/** What the analyser can't make a chart from, worded for the person who dropped the file. */
export class AnalysisError extends ImportError {}

export const TARGET_ROWS_PER_SECOND = 4.0; // what the row grid is nudged towards: fast enough to be musical, slow enough to tap
export const MIN_ROWS_PER_SECOND = 2.4;
export const MAX_ROWS_PER_SECOND = 6.2;

/**
 * The game lays tiles on a grid of equally spaced "rows". The analyser looks for the row rate (rows
 * per second) and phase (the moment of row 0) at which the music's onsets land on the grid most
 * often, searching finely enough that a whole song stays in step. Because only the row grid
 * matters, the usual halving/doubling mistakes of tempo detection hardly matter: 60 BPM with four
 * rows a beat is the same grid as 120 BPM with two.
 */
export interface Grid {
  /** Rows per second. */
  rate: number;
  /** Audio time of row 0, in seconds (under one row). */
  phase: number;
  /** How strongly the music lands on the grid. */
  score: number;
  contrast: number;
}

export const rowLength = (grid: Pick<Grid, 'rate'>) => 1 / grid.rate;

/** Rows per beat (1, 2 or 4) and the BPM that gives, so the BPM reads like a real tempo. */
export function pickRowsPerBeat(rate: number): { rowsPerBeat: number; bpm: number } {
  const options = [1, 2, 4].map((rowsPerBeat) => ({ rowsPerBeat, bpm: (60 * rate) / rowsPerBeat }));
  const sensible = options.filter((option) => option.bpm >= 78 && option.bpm < 175);
  const pool = sensible.length > 0 ? sensible : options;
  const distance = (bpm: number) => Math.abs(Math.log(bpm / 120));
  return pool.reduce((best, option) => (distance(option.bpm) < distance(best.bpm) ? option : best));
}

/** The rows per beat that puts a hand-entered tempo nearest TARGET_ROWS_PER_SECOND. */
export function rowsPerBeatForBpm(bpm: number): number {
  const distance = (rowsPerBeat: number) => Math.abs(Math.log((bpm * rowsPerBeat) / 60 / TARGET_ROWS_PER_SECOND));
  return [1, 2, 4].reduce((best, rowsPerBeat) => (distance(rowsPerBeat) < distance(best) ? rowsPerBeat : best));
}

/**
 * The mean envelope on a grid of period 1/rate, for each phase. (Onset time = frame time + ENV_LAG,
 * and the envelope is read between frames by linear interpolation.)
 */
function gridScores(env: Float64Array, rate: number, phases: readonly number[]): number[] {
  const end = env.length / FPS - 0.1;
  const highest = Math.max(...phases);
  const count = Math.max(8, Math.trunc((end - highest) * rate));
  const stepFrames = FPS / rate;
  const last = env.length - 1.001;
  return phases.map((phase) => {
    const first = (phase - ENV_LAG) * FPS;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const position = first + i * stepFrames;
      const p = position < 0 ? 0 : position > last ? last : position;
      const lower = Math.trunc(p);
      const fraction = p - lower;
      sum += env[lower] * (1 - fraction) + env[lower + 1] * fraction;
    }
    return sum / count;
  });
}

/** The values start, start + step, … while below `stop` (numpy's `arange`). */
function* range(start: number, stop: number, step: number) {
  for (let i = 0; ; i++) {
    const value = start + i * step;
    if (value >= stop) return;
    yield value;
  }
}

/** The best (rate, phase) within ±`width` (a fraction) of `centre` rows per second. */
export function searchGrid(env: Float64Array, centre: number, width: number): Grid {
  const coarse = 1.6e-4;
  let bestRate = centre;
  let bestPhase = 0;
  let bestScore = -1;

  const consider = (rate: number, phases: number[]) => {
    const scores = gridScores(env, rate, phases);
    let j = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[j]) j = i;
    if (scores[j] > bestScore) {
      bestRate = rate;
      bestPhase = phases[j];
      bestScore = scores[j];
    }
  };

  for (const factor of range(-width, width + coarse / 2, coarse)) {
    const rate = centre * (1 + factor);
    consider(rate, Array.from(range(0, 1 / rate, 0.006)));
  }

  const fine = coarse / 8;
  const coarseRate = bestRate;
  const coarsePhase = bestPhase;
  for (const factor of range(-3 * coarse, 3 * coarse + fine / 2, fine)) {
    const rate = coarseRate * (1 + factor);
    consider(rate, Array.from(range(-0.012, 0.012 + 1e-9, 0.0015), (offset) => coarsePhase + offset));
  }

  const row = 1 / bestRate;
  let sum = 0;
  for (let i = 0; i < env.length; i++) sum += env[i];
  const baseline = sum / env.length || 1e-9;
  return { rate: bestRate, phase: modulo(bestPhase, row), score: bestScore, contrast: bestScore / baseline };
}

/**
 * Rough tempos (BPM): the strongest repeat lengths of the onset envelope, from its autocorrelation
 * (how alike the envelope is to itself a moment later). A repeat every L seconds is a tempo of
 * 60 / L, but also of half or double that, which the grid search tries as well.
 */
export function tempoCandidates(env: Float64Array): number[] {
  const n = env.length;
  const minLag = Math.max(2, Math.floor((FPS * 60) / 320));
  const maxLag = Math.min(n - 2, Math.ceil((FPS * 60) / 30));
  if (maxLag <= minLag + 2) return [];

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;

  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += x[i] * x[i + lag];
    r[lag] = sum / (n - lag);
  }

  const peaks: { lag: number; height: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] > 0 && r[lag] > r[lag - 1] && r[lag] >= r[lag + 1]) {
      const curve = r[lag - 1] - 2 * r[lag] + r[lag + 1];
      const shift = curve < 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / curve : 0; // (the top of a parabola through the peak)
      peaks.push({ lag: lag + clamp(shift, -0.5, 0.5), height: r[lag] });
    }
  }
  peaks.sort((a, b) => b.height - a.height);
  return peaks.slice(0, 8).map((peak) => (60 * FPS) / peak.lag);
}

/** Prefer grids near TARGET_ROWS_PER_SECOND: a log-normal bump, so 2x or 0.5x is heavily discounted. */
export function prior(rate: number): number {
  return Math.exp(-0.5 * (Math.log(rate / TARGET_ROWS_PER_SECOND) / 0.35) ** 2);
}

export interface FoundGrid {
  grid: Grid;
  rowsPerBeat: number;
  bpm: number;
}

/** The row grid, rows per beat and BPM: from a tempo given by hand, or found from the music. */
export function findGrid(features: Features, bpm: number | undefined, onProgress?: (fraction: number) => void): FoundGrid {
  const env = features.env;
  if (bpm !== undefined) {
    const rowsPerBeat = rowsPerBeatForBpm(bpm);
    const grid = searchGrid(env, (bpm * rowsPerBeat) / 60, 0.02);
    return { grid, rowsPerBeat, bpm: (60 * grid.rate) / rowsPerBeat };
  }

  const centres: number[] = [];
  for (const tempo of tempoCandidates(env)) {
    for (const multiple of [0.5, 1, 2, 4]) {
      const rate = (tempo / 60) * multiple;
      if (rate >= MIN_ROWS_PER_SECOND && rate <= MAX_ROWS_PER_SECOND && centres.every((c) => Math.abs(rate / c - 1) > 0.015)) {
        centres.push(rate);
      }
    }
  }
  if (centres.length === 0) throw new AnalysisError("Couldn't find a steady beat in that audio. Try giving the tempo by hand.");

  let best = searchGrid(env, centres[0], 0.03);
  for (let i = 1; i < centres.length; i++) {
    onProgress?.(i / centres.length);
    const grid = searchGrid(env, centres[i], 0.03);
    if (grid.contrast * prior(grid.rate) > best.contrast * prior(best.rate)) best = grid;
  }
  onProgress?.(1);
  const { rowsPerBeat, bpm: tempo } = pickRowsPerBeat(best.rate);
  return { grid: best, rowsPerBeat, bpm: tempo };
}

/** Where the strong onsets are: the frames that beat everything within four either side, and how strong. */
function strongOnsets(env: Float64Array): { times: number[]; heights: number[] } | undefined {
  const n = env.length;
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!(env[i] > 0)) continue;
    let top = true;
    for (let step = 1; step <= 4 && top; step++) {
      // (wrapping round the ends, as the reference analyser does)
      if (env[i] < env[(i + step) % n] || env[i] < env[(i - step + n) % n]) top = false;
    }
    if (top) peaks.push(i);
  }
  if (peaks.length < 12) return undefined;
  const heights = peaks.map((i) => env[i]);
  const floor = 0.2 * percentile(heights, 95); // the flicker between hits doesn't count
  const times: number[] = [];
  const kept: number[] = [];
  peaks.forEach((frame, i) => {
    if (heights[i] >= floor) {
      times.push(frame / FPS + ENV_LAG);
      kept.push(heights[i]);
    }
  });
  return times.length < 12 ? undefined : { times, heights: kept };
}

/** (confidence 0–1, drift in seconds): how many strong onsets sit on the grid, and how far it slides over the song. */
export function gridQuality(features: Features, grid: Grid): { confidence: number; drift: number } {
  const onsets = strongOnsets(features.env);
  if (!onsets) return { confidence: 0, drift: 0 };
  const { times, heights } = onsets;
  const row = rowLength(grid);

  // The share of the hitting (louder hits count for more) that lands within 0.2 of a row of the grid.
  // Hits scattered at random would put 40% of it there, so that is zero confidence.
  let near = 0;
  let all = 0;
  times.forEach((time, i) => {
    const error = modulo((time - grid.phase) / row + 0.5, 1) - 0.5; // in rows, -0.5..0.5
    all += heights[i];
    if (Math.abs(error) <= 0.2) near += heights[i];
  });
  const confidence = clamp((near / all - 0.4) / 0.5, 0, 1);
  return { confidence, drift: gridDrift(times, heights, grid, features.duration) };
}

/**
 * How far (seconds) the beat slides against the grid between the first and last part of the song.
 *
 * Each stretch of the song gets its own beat phase: the average of the hits' positions within a
 * row, taken round a circle because a row's end is also its start. The phases are then followed
 * from stretch to stretch (unwrapped), so a slide of more than a row is still seen as one.
 */
function gridDrift(times: number[], heights: number[], grid: Grid, duration: number): number {
  const row = rowLength(grid);
  const stretches = Math.trunc(Math.min(8, Math.max(2, Math.floor(duration / 12))));
  const angles: number[] = [];
  for (let s = 0; s < stretches; s++) {
    const low = (duration * s) / stretches;
    const high = (duration * (s + 1)) / stretches;
    let count = 0;
    let weight = 0;
    let x = 0;
    let y = 0;
    times.forEach((time, i) => {
      if (time < low || time >= high) return;
      const turn = 2 * Math.PI * ((time - grid.phase) / row);
      count++;
      weight += heights[i];
      x += heights[i] * Math.cos(turn);
      y += heights[i] * Math.sin(turn);
    });
    if (count < 6) continue;
    if (Math.hypot(x, y) < 0.3 * weight) continue; // no clear beat here (a quiet break, say)
    angles.push(Math.atan2(y, x));
  }
  if (angles.length < 2) return 0;

  let offset = 0;
  let lowest = angles[0];
  let highest = angles[0];
  for (let i = 1; i < angles.length; i++) {
    const step = angles[i] - angles[i - 1];
    offset += modulo(step + Math.PI, 2 * Math.PI) - Math.PI - step;
    const followed = angles[i] + offset;
    lowest = Math.min(lowest, followed);
    highest = Math.max(highest, followed);
  }
  return ((highest - lowest) / (2 * Math.PI)) * row;
}
