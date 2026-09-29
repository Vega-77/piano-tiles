/**
 * A running commentary on what the game does with each tap, shown by the `?input` readout. Nothing is built or kept
 * unless something is listening, so a normal game pays nothing for it.
 */
type Listener = (line: string) => void;

let listener: Listener | null = null;

/** Start (or, with `null`, stop) listening. There is only ever one listener: the readout. */
export function listenToTrace(next: Listener | null): void {
  listener = next;
}

export const tracing = (): boolean => listener !== null;

/** Say what happened. `line` only runs if someone is listening. */
export function trace(line: () => string): void {
  if (listener) listener(line());
}

/** Seconds as signed milliseconds, for lines like `+38ms` (late) and `−120ms` (early). */
export function signedMs(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${ms < 0 ? '−' : '+'}${Math.abs(ms)}ms`;
}
