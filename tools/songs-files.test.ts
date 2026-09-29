// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSongsFileHandler, songFile } from './songs-files.ts';

describe('which song file a path is for', () => {
  it('takes the manifest and a song’s own files', () => {
    expect(songFile('/index.json')).toEqual(['index.json']);
    expect(songFile('/demo/chart.json')).toEqual(['demo', 'chart.json']);
    expect(songFile('demo/audio-1a2b3c4d.mp3')).toEqual(['demo', 'audio-1a2b3c4d.mp3']);
  });

  it('refuses anything that could leave the folder', () => {
    for (const path of ['/', '/..', '/../x.json', '/demo/../index.json', '/demo/..', '/demo/a/b', '/DEMO/chart.json', '/-x/chart.json', '/demo/.env', '/demo/', '//demo/x', '/a b/chart.json', '/demo/x..json']) {
      expect(songFile(path), path).toBeUndefined();
    }
  });
});

describe('serving the songs folder', () => {
  let folder: string;
  let secret: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'piano-tiles-files-'));
    await mkdir(join(folder, 'demo'));
    await writeFile(join(folder, 'index.json'), '{"songs":["demo"]}');
    await writeFile(join(folder, 'demo', 'chart.json'), '{"id":"demo"}');
    await writeFile(join(folder, 'demo', 'audio-1a2b3c4d.mp3'), Buffer.from([1, 2, 3, 4, 5]));
    await mkdir(join(folder, 'folder-not-file'));
    secret = `${folder}-secret.json`; // beside the folder, not in it
    await writeFile(secret, 'TOP SECRET');

    const handler = createSongsFileHandler(folder);
    server = createServer((req, res) => {
      // (mounted the way the dev server mounts it: the `/songs` part is already gone)
      req.url = (req.url ?? '/').replace(/^\/songs/, '') || '/';
      handler(req, res, (error) => {
        res.statusCode = error ? 500 : 599;
        res.end(error ? 'broke' : 'fell through');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
    await rm(secret, { force: true });
  });

  function get(path: string, method = 'GET') {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('serves the manifest, a chart and the audio with their types, and never caches them', async () => {
    const manifest = await get('/songs/index.json');
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/json');
    expect(manifest.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(manifest.body.toString())).toEqual({ songs: ['demo'] });

    expect(JSON.parse((await get('/songs/demo/chart.json')).body.toString())).toEqual({ id: 'demo' });

    const audio = await get('/songs/demo/audio-1a2b3c4d.mp3');
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.headers['content-length']).toBe('5');
    expect([...audio.body]).toEqual([1, 2, 3, 4, 5]);
  });

  it('answers a HEAD request with the headers and no body', async () => {
    const head = await get('/songs/demo/audio-1a2b3c4d.mp3', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('5');
    expect(head.body).toHaveLength(0);
  });

  it('ignores a query string, and files added after the server started are there at once', async () => {
    expect((await get('/songs/demo/chart.json?x=1')).status).toBe(200);
    await mkdir(join(folder, 'later'));
    await writeFile(join(folder, 'later', 'chart.json'), '{"id":"later"}');
    expect((await get('/songs/later/chart.json')).status).toBe(200);
  });

  it('gives a plain 404 (not the app’s page) for what is not there', async () => {
    for (const path of ['/songs/nothing.json', '/songs/demo/missing.json', '/songs/ghost/chart.json', '/songs/folder-not-file/chart.json', '/songs/demo']) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.headers['content-type']).toContain('text/plain');
    }
  });

  it('refuses paths that climb out of the folder, however they are spelt', async () => {
    const name = secret.slice(secret.lastIndexOf('/') + 1).slice(secret.lastIndexOf('\\') + 1);
    const attempts = [
      '/songs/demo/%2e%2e%2findex.json',
      '/songs/demo/..%5cindex.json',
      '/songs/demo/%2e%2e%2f%2e%2e%2f' + encodeURIComponent(name),
      '/songs/..%2f' + encodeURIComponent(name),
      '/songs/%2e%2e%5c' + encodeURIComponent(name),
      '/songs/%00',
      '/songs/%zz',
    ];
    for (const path of attempts) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body.toString(), path).not.toContain('SECRET');
    }
  });

  it('never leaves the folder even when the address is tidied on the way in', async () => {
    // A client (or the dev server) may collapse `..` before the handler sees it. What is left is at most inside the folder.
    const name = encodeURIComponent(secret.slice(Math.max(secret.lastIndexOf('/'), secret.lastIndexOf('\\')) + 1));
    for (const path of [`/songs/../${name}`, `/songs/../../${name}`, `/songs/%2e%2e/${name}`]) {
      const answer = await get(path);
      expect(answer.body.toString(), path).not.toContain('SECRET');
    }
  });

  it('leaves other kinds of request to whoever is next', async () => {
    const posted = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/songs/index.json', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(posted).toBe(599);
  });
});
