import { FPS, type Features } from './features';
import { type Grid, rowLength } from './grid';

/**
 * How long a lap may be. A song longer than the top of its range is played only up to a stopping
 * point inside the range, so a lap stays a comfortable length whatever was dropped in (and, as
 * a side effect, a song's audio stays small enough to carry around).
 */
export type Length = 'short' | 'medium' | 'long';
export const LENGTHS: readonly Length[] = ['short', 'medium', 'long'];
export const DEFAULT_LENGTH: Length = 'medium';

/** Where a lap of each length may stop, in seconds of the recording. */
export const LENGTH_SECONDS: Record<Length, { min: number; max: number }> = {
  short: { min: 60, max: 70 },
  medium: { min: 70, max: 80 },
  long: { min: 80, max: 90 },
};

/** A length as it was saved with a chart, read back (anything unrecognised is the default). */
export function lengthFrom(saved: unknown): Length {
  return LENGTHS.find((length) => length === saved) ?? DEFAULT_LENGTH;
}

/** Bars of the song to listen to either side of a stopping point when judging how quiet it is there. */
const CONTEXT_BARS = 4;
/** How much a quiet moment counts against the bar being on a phrase (a phrase is 2, 4 or 8 bars). */
const QUIET_WEIGHT = 2;

/** Mean of `values` (one per frame) between two times, in seconds. */
function meanBetween(values: Float64Array, from: number, to: number): number {
  const first = Math.max(0, Math.floor(from * FPS));
  const last = Math.min(values.length - 1, Math.ceil(to * FPS));
  let sum = 0;
  for (let i = first; i <= last; i++) sum += values[i];
  return last >= first ? sum / (last - first + 1) : 0;
}

/**
 * Where in the recording (seconds) a lap stops, or undefined if the whole recording is short enough.
 *
 * The stop is always on a bar line, so the lap is a whole number of bars and ends where the music
 * does: of the bar lines in the range, the one that scores best on two things. One is being on a
 * phrase (every 2, 4 or 8 bars from the first beat: songs are built in those blocks, so a stop there
 * is the end of a verse or a chorus and not the middle of one). The other is the music being quieter
 * there than in the few bars before (a break, a drum fill dropping out). Level with each other, the
 * later stop wins, to give the player more of the song.
 */
export function chooseEnd(features: Features, grid: Grid, rowsPerBeat: number, seconds: number, length: Length): number | undefined {
  const { min, max } = LENGTH_SECONDS[length];
  if (seconds <= max) return undefined;

  const beat = rowsPerBeat * rowLength(grid);
  const bar = 4 * beat;
  const firstBar = Math.max(1, Math.ceil((min - grid.phase) / bar - 1e-9));
  const lastBar = Math.floor((max - grid.phase) / bar + 1e-9);

  let best: { end: number; score: number } | undefined;
  for (let bars = firstBar; bars <= lastBar; bars++) {
    const end = grid.phase + bars * bar;
    const near = meanBetween(features.rms, end - 0.5 * beat, end + 0.5 * beat);
    const before = meanBetween(features.rms, end - CONTEXT_BARS * bar, end);
    const quiet = before > 0 ? Math.min(1, Math.max(0, 1 - near / before)) : 0;
    const phrase = bars % 8 === 0 ? 3 : bars % 4 === 0 ? 2 : bars % 2 === 0 ? 1 : 0;
    const score = phrase + QUIET_WEIGHT * quiet;
    if (!best || score >= best.score - 1e-9) best = { end, score };
  }
  // (A bar longer than the range, which no tempo the analyser accepts would give, has no stop in it.)
  return best?.end ?? Math.min(max, seconds);
}
