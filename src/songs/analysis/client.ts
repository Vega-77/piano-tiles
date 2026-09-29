import { Cancelled, ImportError } from '../errors';
import { analyze, type AnalyzeOptions, type Measured, type Progress } from './analyze';
import type { AnalyzeReply, AnalyzeRequest } from './protocol';

export type Analyser = (
  samples: Float32Array,
  options: AnalyzeOptions,
  onProgress?: (progress: Progress) => void,
  signal?: AbortSignal,
) => Promise<Measured>;

function startWorker(): Worker | undefined {
  if (typeof Worker === 'undefined') return undefined;
  try {
    return new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return undefined;
  }
}

/**
 * Finds the beat in `samples` (mono at the analyser's sample rate) and lays tiles on it, in a
 * worker so the page keeps working. The samples are handed to the worker, so they can't be used
 * afterwards. Where there are no workers it runs right here, which takes a second or two for a
 * song. Rejects with `Cancelled` if `signal` is aborted.
 */
export const analyzeSamples: Analyser = (samples, options, onProgress, signal) => {
  if (signal?.aborted) return Promise.reject(new Cancelled());
  const worker = startWorker();
  if (!worker) {
    return new Promise((resolve, reject) => {
      try {
        resolve(analyze(samples, options, onProgress));
      } catch (error) {
        reject(error);
      }
    });
  }

  return new Promise<Measured>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new Cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<AnalyzeReply>) => {
      const reply = event.data;
      if (reply.type === 'progress') {
        onProgress?.(reply.progress);
        return;
      }
      finish();
      if (reply.type === 'done') resolve(reply.result);
      else reject(new ImportError(reply.message));
    };
    worker.onerror = () => {
      finish();
      reject(new ImportError("This browser couldn't start the part of the app that listens to songs. Try reloading the page."));
    };

    const request: AnalyzeRequest = { samples, options };
    worker.postMessage(request, [samples.buffer]);
  });
};
