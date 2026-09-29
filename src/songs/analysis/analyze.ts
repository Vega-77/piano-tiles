import type { ChartFile } from '../chart';
import { SAMPLE_RATE, computeFeatures } from './features';
import { MAX_ROWS_PER_SECOND, findGrid, gridQuality, AnalysisError } from './grid';
import { type Density, chooseTiles, describe, difficultyOf, formatTiles } from './tiles';

export { AnalysisError } from './grid';
export { DENSITIES, type Density } from './tiles';

export const MIN_SECONDS = 5;
/** Longer than this and a phone would run out of memory holding the decoded audio. */
export const MAX_SECONDS = 10 * 60;
/** Seconds the beat may slide against the grid before we say so (a PERFECT is ±0.075 s). */
const DRIFT_WARNING = 0.08;

export interface AnalyzeOptions {
  /** The tempo, if detection gets it wrong. */
  bpm?: number;
  density: Density;
}

export interface Progress {
  stage: 'listen' | 'grid' | 'chart';
  message: string;
  /** How far through the whole analysis, 0–1, if known. */
  fraction?: number;
}

/** What the analysis finds out about a song; the rest of a chart (name, audio, colours) comes from elsewhere. */
export type Measured = Pick<ChartFile, 'bpm' | 'rowsPerBeat' | 'offset' | 'duration' | 'difficulty' | 'chart' | 'analysis'>;

const round = (value: number, places: number) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/**
 * Finds the beat in mono audio at SAMPLE_RATE and lays tiles on it. Throws an AnalysisError, worded
 * for the person who dropped the file, if there is nothing to chart.
 */
export function analyze(samples: Float32Array, options: AnalyzeOptions, onProgress?: (progress: Progress) => void): Measured {
  const seconds = samples.length / SAMPLE_RATE;
  if (seconds < MIN_SECONDS) throw new AnalysisError('That audio is too short (under five seconds).');
  if (seconds > MAX_SECONDS) throw new AnalysisError(`That song is over ${MAX_SECONDS / 60} minutes long.`);

  // (The listening is most of the work, then the grid search.)
  onProgress?.({ stage: 'listen', message: 'Listening for hits', fraction: 0 });
  const features = computeFeatures(samples, (fraction) =>
    onProgress?.({ stage: 'listen', message: 'Listening for hits', fraction: 0.7 * fraction }),
  );

  onProgress?.({ stage: 'grid', message: 'Finding the beat', fraction: 0.7 });
  const found = findGrid(features, options.bpm, (fraction) =>
    onProgress?.({ stage: 'grid', message: 'Finding the beat', fraction: 0.7 + 0.25 * fraction }),
  );
  const { grid, rowsPerBeat, bpm } = found;
  const { confidence, drift } = gridQuality(features, grid);

  const rows = Math.max(1, Math.ceil((features.duration - grid.phase) * grid.rate - 1e-9));
  onProgress?.({ stage: 'chart', message: 'Placing the tiles', fraction: 0.95 });
  const tiles = chooseTiles(features, grid, rows, options.density, rowsPerBeat);
  const numbers = describe(tiles, grid, features.duration);
  const doubles = [...tiles.tokens.values()].filter((tile) => tile.kind === 'double').length;

  const warnings: string[] = [];
  if (confidence < 0.35) {
    warnings.push('The beat is weak or uneven, so tiles may not line up with the music. Try setting the tempo by hand.');
  }
  if (drift > DRIFT_WARNING) {
    warnings.push(
      'The tempo drifts over the song, so tiles may slide out of time. Setting the tempo by hand can help if it is only part of the song.',
    );
  }
  if (grid.rate > MAX_ROWS_PER_SECOND - 0.3) warnings.push('This song is very fast, so the tiles will fall quickly.');

  onProgress?.({ stage: 'chart', message: 'Placing the tiles', fraction: 1 });
  return {
    bpm: round(bpm, 3),
    rowsPerBeat,
    offset: round(grid.phase, 4),
    duration: round(features.duration, 3),
    difficulty: difficultyOf(numbers.peak, numbers.average, doubles),
    chart: formatTiles(tiles),
    analysis: {
      confidence: round(confidence, 3),
      drift: round(drift, 4),
      manualBpm: options.bpm !== undefined,
      peakRate: round(numbers.peak, 2),
      tiles: tiles.tokens.size,
      rows,
      density: round(tiles.tokens.size / rows, 3),
      level: options.density,
      warnings,
    },
  };
}

/** A 32-bit number that is the same for the same recording (it looks at about four thousand of its samples). */
export function fingerprintOf(samples: Float32Array): number {
  let hash = 2166136261;
  const stride = Math.max(1, Math.floor(samples.length / 4096));
  for (let i = 0; i < samples.length; i += stride) {
    hash ^= Math.round(samples[i] * 32767) & 0xffff;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** A hue (0–359) for a song's colours, from the audio itself: the same recording always gets the same one. */
export function hueOf(samples: Float32Array): number {
  return (fingerprintOf(samples) >>> 8) % 360;
}
