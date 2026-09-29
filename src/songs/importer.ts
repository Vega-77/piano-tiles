import { validateChart, type ChartFile } from './chart';

/**
 * The app's side of adding songs. While `npm run dev` runs, the dev server takes a song file,
 * runs the analyser on it (`tools/analyze.py`) and writes the result into `public/songs/`, where
 * it is committed like any other file. The published site has no analyser behind it, so it can
 * only play the songs that were committed.
 */

/** Where the dev server answers, relative to the page. */
const BRIDGE = '__songs/';

/** Whether this build can add songs: only the dev server has the analyser behind it. */
export const CAN_IMPORT: boolean = import.meta.env.DEV;

/** The largest file the dev server takes (keep in step with `MAX_UPLOAD_BYTES` in tools/songs-bridge.ts). */
export const MAX_UPLOAD_MB = 300;

export type Density = 'easy' | 'normal' | 'hard';
export const DENSITIES: readonly Density[] = ['easy', 'normal', 'hard'];

/** Something that went wrong adding or changing a song, worded for the person who asked. */
export class ImportError extends Error {}

export interface Stage {
  stage: string;
  message: string;
}

export interface Job {
  /** The page's `fetch` unless a test passes another. */
  fetcher?: typeof fetch;
  base?: string;
  signal?: AbortSignal;
  onStage?: (stage: Stage) => void;
}

export interface ImportOptions {
  title?: string;
  artist?: string;
  /** The tempo, when it is known: the analyser only looks for it if this is left out. */
  bpm?: number;
  density?: Density;
}

export interface RechartOptions {
  title?: string;
  bpm?: number;
  density?: Density;
  /** Forget a tempo that was given by hand and detect it again. */
  auto?: boolean;
}

export interface TuneOptions {
  title?: string;
  artist?: string;
  /** How far, in milliseconds, to move the audio against the tiles: positive if the tiles are early. */
  nudgeMs?: number;
}

// ---- reading the answer -----------------------------------------------------------------------

/** Cuts a stream of text into lines, holding back a line until the end of it arrives. */
export function lineSplitter() {
  let rest = '';
  return {
    push(chunk: string): string[] {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      return lines;
    },
    flush(): string[] {
      const last = rest;
      rest = '';
      return last ? [last] : [];
    },
  };
}

/** Reads the analyser's progress (one JSON event per line) and returns its `done` event. */
export async function readJob(response: Response, onStage?: (stage: Stage) => void): Promise<Record<string, unknown>> {
  let done: Record<string, unknown> | undefined;
  let failure: string | undefined;

  const handle = (line: string) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // not one of ours
    }
    if (typeof event !== 'object' || event === null) return;
    const e = event as Record<string, unknown>;
    if (e.event === 'stage' && typeof e.message === 'string') onStage?.({ stage: String(e.stage ?? ''), message: e.message });
    else if (e.event === 'done') done = e;
    else if (e.event === 'error') failure = typeof e.message === 'string' ? e.message : 'Something went wrong.';
  };

  const lines = lineSplitter();
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      lines.push(decoder.decode(chunk.value, { stream: true })).forEach(handle);
    }
    lines.push(decoder.decode()).forEach(handle);
  }
  lines.flush().forEach(handle);

  if (failure !== undefined) throw new ImportError(failure);
  if (done) return done;
  if (response.status === 404) throw new ImportError("This copy of the app can't add songs. Run it with `npm run dev`.");
  throw new ImportError(response.ok ? 'The connection closed before the song was finished.' : `The dev server answered with ${response.status}.`);
}

type Request = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function call(path: string, init: Request, job: Job): Promise<Record<string, unknown>> {
  const fetcher = job.fetcher ?? ((input, options) => fetch(input, options));
  const url = new URL(`${BRIDGE}${path}`, job.base ?? document.baseURI).href;
  let response: Response;
  try {
    // The header is what the dev server looks for to know a request came from the app itself.
    response = await fetcher(url, { ...init, cache: 'no-store', signal: job.signal, headers: { ...init.headers, 'X-Piano-Tiles': '1' } });
    return await readJob(response, job.onStage);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (job.signal?.aborted) throw new ImportError('Cancelled.');
    throw new ImportError("Couldn't reach the dev server. Is `npm run dev` still running?");
  }
}

function json(body: unknown): Request {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function chartOf(done: Record<string, unknown>): ChartFile {
  try {
    return validateChart(done.chart);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : 'The analyser sent back a song the app could not read.');
  }
}

// ---- what the app can ask for -----------------------------------------------------------------

/** Whether the analyser is installed. (`message` says what to do if it isn't.) */
export async function checkTools(job: Job = {}): Promise<{ available: boolean; message?: string }> {
  const fetcher = job.fetcher ?? ((input, options) => fetch(input, options));
  try {
    const response = await fetcher(new URL(`${BRIDGE}status`, job.base ?? document.baseURI).href, {
      cache: 'no-store',
      signal: job.signal,
      headers: { 'X-Piano-Tiles': '1' },
    });
    if (!response.ok) return { available: false, message: "This copy of the app can't add songs. Run it with `npm run dev`." };
    const body = (await response.json()) as { available?: unknown; message?: unknown };
    return { available: body.available === true, message: typeof body.message === 'string' ? body.message : undefined };
  } catch {
    return { available: false, message: "Couldn't reach the dev server." };
  }
}

/** Sends a song file to be analysed and saved. Resolves with its chart. */
export async function importSong(file: File, options: ImportOptions = {}, job: Job = {}): Promise<ChartFile> {
  if (file.size === 0) throw new ImportError('That file is empty.');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new ImportError(`That file is over ${MAX_UPLOAD_MB} MB.`);
  const query = new URLSearchParams({ name: file.name });
  const title = options.title?.trim();
  const artist = options.artist?.trim();
  if (title) query.set('title', title);
  if (artist) query.set('artist', artist);
  if (options.bpm !== undefined && Number.isFinite(options.bpm)) query.set('bpm', String(options.bpm));
  if (options.density) query.set('density', options.density);
  const done = await call(`import?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }, job);
  return chartOf(done);
}

/** Puts the tiles of a saved song on the beat again, with another tempo or busyness. */
export async function rechartSong(id: string, options: RechartOptions = {}, job: Job = {}): Promise<ChartFile> {
  return chartOf(await call('rechart', json({ id, ...options }), job));
}

/** Changes a saved song's name, or moves its audio against its tiles (no analysis). */
export async function tuneSong(id: string, options: TuneOptions, job: Job = {}): Promise<ChartFile> {
  return chartOf(await call('tune', json({ id, ...options }), job));
}

/** Deletes a saved song and its audio. */
export async function removeSong(id: string, job: Job = {}): Promise<void> {
  await call('remove', json({ id }), job);
}
