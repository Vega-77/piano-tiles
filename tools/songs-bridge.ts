import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The dev server's door to the song analyser (`tools/analyze.py`): the app drops a song on it, it
 * runs the analyser and streams the progress back. It exists only while `npm run dev` runs and
 * only answers the app itself: anything else on this computer, or any web page the browser has
 * open, is turned away (see `checkTrusted`).
 */

export const BRIDGE_HEADER = 'x-piano-tiles';
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

const SONG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DENSITIES = ['easy', 'normal', 'hard'];
const MAX_NUDGE_MS = 500; // keep in step with MAX_NUDGE in src/songs/chart.ts

export interface Refusal {
  status: number;
  message: string;
}

const refuse = (status: number, message: string): Refusal => ({ status, message });

class BadRequest extends Error {}

// ---- who may ask ------------------------------------------------------------------------------

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;

/**
 * Whether a request really comes from the app. Three checks, so that no single one is all that
 * stands between a stray web page and the analyser (and the files it writes):
 *  - the Host is this computer, which stops a page that has tricked the browser into resolving its
 *    own name to 127.0.0.1;
 *  - the request carries our own header. A page on another site can't add one without a CORS
 *    preflight, which the dev server doesn't grant to it;
 *  - if the browser says where it came from (Origin, Sec-Fetch-Site), that is this same server.
 */
export function checkTrusted(headers: IncomingHttpHeaders): Refusal | null {
  const host = headers.host ?? '';
  if (!LOCAL_HOST.test(host)) return refuse(403, 'Songs can only be added from the app running on this computer.');
  if (headers[BRIDGE_HEADER] !== '1') return refuse(403, 'That request did not come from the app.');
  const origin = headers.origin;
  if (origin !== undefined) {
    let sameServer = false;
    try {
      sameServer = new URL(origin).host === host;
    } catch {
      // (Origin: null, or junk)
    }
    if (!sameServer) return refuse(403, 'That request came from another site.');
  }
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return refuse(403, 'That request came from another site.');
  return null;
}

// ---- what to run ------------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function songId(value: unknown): string {
  if (typeof value !== 'string' || !SONG_ID.test(value)) throw new BadRequest('That is not a valid song id.');
  return value;
}

function text(value: unknown, max = 120): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequest('Expected text.');
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function number(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BadRequest(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function density(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !DENSITIES.includes(value)) throw new BadRequest('The density must be easy, normal or hard.');
  return value;
}

/** A file name without its folder or extension: the default title of an uploaded song. */
export function titleFromFileName(name: string | undefined): string {
  const file = (name ?? '').split(/[\\/]/).pop() ?? '';
  return text(file.replace(/\.[^.]*$/, '').replace(/[_]+/g, ' ')) || 'Untitled';
}

/** `--name=value`, one argument, so a value that starts with a dash can't be taken for an option. */
const option = (name: string, value: string | number | undefined): string[] => (value === undefined ? [] : [`--${name}=${value}`]);

export type Action = 'import' | 'rechart' | 'tune' | 'remove';
export const ACTIONS: readonly Action[] = ['import', 'rechart', 'tune', 'remove'];

/**
 * Checks what the app asked for and turns it into the analyser's arguments. Nothing from the
 * request reaches the command line except values checked here, and the analyser is started
 * without a shell.
 */
export function planCommand(action: Action, input: unknown, songs: string, file?: string): { args: string[] } | Refusal {
  try {
    const body = record(input);
    const out = ['--out', songs];
    switch (action) {
      case 'import': {
        if (!file) throw new BadRequest('No file.');
        const title = text(body.title) || titleFromFileName(text(body.name, 260));
        return {
          args: [
            'import', file, ...out,
            ...option('title', title),
            ...option('artist', text(body.artist)),
            ...option('bpm', number(body.bpm, 'The tempo', 40, 300)),
            ...option('density', density(body.density)),
          ],
        };
      }
      case 'rechart':
        return {
          args: [
            'rechart', songId(body.id), ...out,
            ...option('title', text(body.title)),
            ...option('bpm', number(body.bpm, 'The tempo', 40, 300)),
            ...option('density', density(body.density)),
            ...(body.auto === true ? ['--auto'] : []),
          ],
        };
      case 'tune':
        return {
          args: [
            'tune', songId(body.id), ...out,
            ...option('title', text(body.title)),
            ...option('artist', text(body.artist)),
            ...option('nudge-ms', number(body.nudgeMs, 'The nudge', -MAX_NUDGE_MS, MAX_NUDGE_MS)),
          ],
        };
      case 'remove':
        return { args: ['remove', songId(body.id), ...out] };
    }
  } catch (error) {
    if (error instanceof BadRequest) return refuse(400, error.message);
    throw error;
  }
}

// ---- the analyser's output --------------------------------------------------------------------

export type AnalyzerEvent =
  | { event: 'stage'; stage: string; message: string }
  | { event: 'done'; [key: string]: unknown }
  | { event: 'error'; message: string };

/** Cuts a stream of text into lines, holding back a line until its end arrives. */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const lines = (this.rest + chunk).split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    const last = this.rest;
    this.rest = '';
    return last ? [last] : [];
  }
}

/** One line of the analyser's output as an event, or null for anything that isn't one (it's never passed on). */
export function parseEvent(line: string): AnalyzerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as { event?: unknown; message?: unknown };
  if (event.event === 'stage' || event.event === 'done') return value as AnalyzerEvent;
  if (event.event === 'error' && typeof event.message === 'string') return value as AnalyzerEvent;
  return null;
}

// ---- the handler ------------------------------------------------------------------------------

export interface BridgeOptions {
  /** The analyser's Python and script, and where imported songs are kept. */
  python: string;
  script: string;
  /** Options for the interpreter, before the script (Python is put in UTF-8 mode by default). */
  pythonArgs?: string[];
  songsFolder: string;
  /** Where the analyser runs. */
  cwd: string;
  maxUpload?: number;
}

/** A request the handler turns down; it is answered once the job's cleaning up is done. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const fail = (res: ServerResponse, refusal: Refusal) => sendJson(res, refusal.status, { event: 'error', message: refusal.message });

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BadRequest('That request is too big.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('That request was not JSON.');
  }
}

/** What an import's query string asks for, as the object `planCommand` checks. */
function importRequest(query: URLSearchParams): Record<string, unknown> {
  const numeric = (name: string) => (query.get(name) ? Number(query.get(name)) : undefined);
  return {
    name: query.get('name') ?? undefined,
    title: query.get('title') ?? undefined,
    artist: query.get('artist') ?? undefined,
    bpm: numeric('bpm'),
    density: query.get('density') ?? undefined,
  };
}

/** Stops the analyser and what it started (it runs ffmpeg), so a cancelled job leaves nothing behind. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid); // (it was started as the leader of its own group)
  } catch {
    child.kill();
  }
}

/**
 * Handles requests under `/__songs/`:
 *   GET  status    is the analyser set up?
 *   POST import    the body is the song file itself; `?title=&artist=&bpm=&density=&name=` say how
 *   POST rechart   { id, title?, bpm?, density?, auto? }
 *   POST tune      { id, title?, artist?, nudgeMs? }
 *   POST remove    { id }
 * The last four answer with the analyser's progress as JSON lines, ending with `done` or `error`.
 * They run one at a time, and a job's answer only ends once it has cleaned up after itself.
 */
export function createSongsHandler(options: BridgeOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { python, script, pythonArgs = ['-X', 'utf8'], songsFolder, cwd, maxUpload = MAX_UPLOAD_BYTES } = options;
  const notSetUp = 'The song tools are not set up. Run `npm run setup:songs`, then restart `npm run dev`.';
  let busy = false;

  /** Runs the analyser and streams what it says. Resolves once it has stopped; the caller ends the response. */
  function runAnalyzer(args: string[], res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const write = (event: AnalyzerEvent) => {
        if (res.writable) res.write(`${JSON.stringify(event)}\n`);
      };
      let concluded = false; // whether the analyser said how it went (done or error)
      let stderr = '';
      let finished = false;
      const finish = (message?: string) => {
        if (finished) return;
        finished = true;
        if (message && !concluded) write({ event: 'error', message });
        resolve();
      };

      const child = spawn(python, [...pythonArgs, script, ...args], {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
      const splitter = new LineSplitter();
      const handle = (line: string) => {
        const event = parseEvent(line);
        if (!event) return;
        if (event.event !== 'stage') concluded = true;
        write(event);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => splitter.push(chunk).forEach(handle));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on('error', (error) => finish(`Couldn't start the song analyser (${error.message}). Run \`npm run setup:songs\`.`));
      child.on('close', (code) => {
        splitter.flush().forEach(handle);
        const lastLine = stderr.trim().split(/\r?\n/).pop() ?? '';
        finish(`The song analyser stopped unexpectedly${code ? ` (code ${code})` : ''}${lastLine ? `: ${lastLine}` : '.'}`);
      });
      // The tab was closed or the request cancelled: stop the work (and wait for it to stop).
      res.on('close', () => killTree(child));
    });
  }

  /** Saves the body of an import request to a file in `folder`. */
  async function receiveUpload(req: IncomingMessage, folder: string): Promise<string> {
    const tooBig = new Refused(refuse(413, `That file is over ${Math.round(maxUpload / 1024 / 1024)} MB.`));
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > maxUpload) {
      req.resume();
      throw tooBig;
    }
    const file = join(folder, 'upload');
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > maxUpload ? tooBig : null, chunk); // (a body that lied about its length)
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(file));
    } catch (error) {
      throw error instanceof Refused ? error : new Refused(refuse(400, 'The upload was interrupted.'));
    }
    if (received === 0) throw new Refused(refuse(400, 'That file is empty.'));
    return file;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = checkTrusted(req.headers);
    if (refusal) return fail(res, refusal);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/^\/+|\/+$/g, '');

    if (req.method === 'GET' && route === 'status') {
      const ready = existsSync(python);
      return sendJson(res, 200, { available: ready, message: ready ? undefined : notSetUp });
    }
    const action = ACTIONS.find((name) => name === route);
    if (!action) return fail(res, refuse(404, 'Not found.'));
    if (req.method !== 'POST') return fail(res, refuse(405, 'Use POST.'));
    if (!existsSync(python)) return fail(res, refuse(503, notSetUp));
    if (busy) {
      req.resume();
      return fail(res, refuse(409, 'Another song is being worked on. Try again in a moment.'));
    }

    busy = true;
    let folder: string | undefined;
    let turnedAway: Refusal | undefined;
    try {
      let plan: { args: string[] } | Refusal;
      if (action === 'import') {
        folder = await mkdtemp(join(tmpdir(), 'piano-tiles-'));
        const file = await receiveUpload(req, folder);
        plan = planCommand(action, importRequest(url.searchParams), songsFolder, file);
      } else {
        plan = planCommand(action, await readJson(req), songsFolder);
      }
      if ('status' in plan) throw new Refused(plan);
      await runAnalyzer(plan.args, res);
    } catch (error) {
      if (error instanceof Refused) turnedAway = error.refusal;
      else if (error instanceof BadRequest) turnedAway = refuse(400, error.message);
      else throw error;
    } finally {
      // Only when the upload is deleted and the next job may start is the answer finished, so a
      // client that has its answer can send the next request straight away.
      if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      busy = false;
    }
    if (turnedAway) fail(res, turnedAway);
    else res.end();
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[songs]', error);
      fail(res, refuse(500, 'Something went wrong adding the song.'));
    });
  };
}
