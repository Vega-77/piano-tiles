import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Which file of the songs folder a request under `/songs` is for: `index.json`, or `<id>/<file>`. */
export function songFile(pathname: string): string[] | undefined {
  const parts = pathname.replace(/^\//, '').split('/');
  if (parts.length === 1 && parts[0] === 'index.json') return parts;
  if (parts.length === 2 && ID.test(parts[0]) && FILE.test(parts[1]) && !parts[1].includes('..')) return parts;
  return undefined;
}

/**
 * Serves `public/songs/` itself while the dev server runs. Vite only serves the files of `public/`
 * that were there when it started (and even the folder itself, if it did not exist), so a song
 * added in this session would otherwise fall through to the app's own page. A song that isn't there
 * is a plain 404, which the app reads as “no imported songs”. Mount it at `/songs`.
 */
export function createSongsFileHandler(songsFolder: string) {
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = decodeURIComponentSafe(new URL(req.url ?? '/', 'http://localhost').pathname);
    const parts = pathname === undefined ? undefined : songFile(pathname);

    const refuse = () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('No such song file.');
    };
    if (!parts) return refuse();

    const path = join(songsFolder, ...parts);
    const type = CONTENT_TYPES[extname(path).toLowerCase()];
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return refuse();
      size = info.size;
    } catch {
      return refuse();
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', type ?? 'application/octet-stream');
    res.setHeader('Content-Length', size);
    // A song's chart changes when it is re-analysed or tuned, so nothing here may be cached.
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // (A promise nobody catches would take the whole dev server down.)
    serve(req, res).catch((error: unknown) => {
      if (res.headersSent) res.destroy();
      else next(error);
    });
  };
}

function decodeURIComponentSafe(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}
