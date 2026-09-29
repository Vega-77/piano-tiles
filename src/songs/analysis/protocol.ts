import type { AnalyzeOptions, Measured, Progress } from './analyze';

/** What the page sends the analysing worker. The samples are handed over, not copied. */
export interface AnalyzeRequest {
  samples: Float32Array;
  options: AnalyzeOptions;
}

/** What the worker sends back: progress as it goes, then the result or the reason for failing. */
export type AnalyzeReply =
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; result: Measured }
  | { type: 'error'; message: string; /** Whether it was something to tell the player (not a bug). */ expected: boolean };
