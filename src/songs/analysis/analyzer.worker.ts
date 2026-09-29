/**
 * Runs the analysis off the page's thread, so a long song doesn't freeze the menu while it is
 * being listened to. Started by client.ts.
 */
import { ImportError } from '../errors';
import { analyze } from './analyze';
import type { AnalyzeReply, AnalyzeRequest } from './protocol';

interface Scope {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(reply: AnalyzeReply): void;
}
const scope = self as unknown as Scope;

scope.onmessage = (event) => {
  const { samples, options } = event.data;
  try {
    const result = analyze(samples, options, (progress) => scope.postMessage({ type: 'progress', progress }));
    scope.postMessage({ type: 'done', result });
  } catch (error) {
    const expected = error instanceof ImportError;
    scope.postMessage({
      type: 'error',
      expected,
      message: expected ? error.message : 'Something went wrong while listening to the song.',
    });
  }
};
