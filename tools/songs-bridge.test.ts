// @vitest-environment node
import { existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LineSplitter,
  checkTrusted,
  createSongsHandler,
  parseEvent,
  planCommand,
  titleFromFileName,
  type AnalyzerEvent,
} from './songs-bridge.ts';

const trusted = { host: 'localhost:5173', 'x-piano-tiles': '1' };

describe('who may ask', () => {
  it('lets the app in', () => {
    expect(checkTrusted(trusted)).toBeNull();
    expect(checkTrusted({ ...trusted, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' })).toBeNull();
    expect(checkTrusted({ host: '127.0.0.1:4000', 'x-piano-tiles': '1', origin: 'http://127.0.0.1:4000' })).toBeNull();
  });

  it.each([
    ['a host that is not this computer', { host: 'example.com', 'x-piano-tiles': '1' }],
    ['this computer by its address on the network', { host: '192.168.1.20:5173', 'x-piano-tiles': '1' }],
    ['a site that only starts with localhost', { host: 'localhost.evil.test', 'x-piano-tiles': '1' }],
    ['no host', { 'x-piano-tiles': '1' }],
    ['a request without the app’s header', { host: 'localhost:5173' }],
    ['the wrong header value', { host: 'localhost:5173', 'x-piano-tiles': 'yes' }],
    ['another page on this computer', { ...trusted, origin: 'http://localhost:9999' }],
    ['another site', { ...trusted, origin: 'https://evil.test' }],
    ['a null origin', { ...trusted, origin: 'null' }],
    ['a cross-site fetch', { ...trusted, 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch from a sibling port', { ...trusted, 'sec-fetch-site': 'same-site' }],
  ])('turns away %s', (_name, headers) => {
    expect(checkTrusted(headers)?.status).toBe(403);
  });
});

describe('planning the analyser command', () => {
  const songs = '/songs';

  it('imports a file with what was asked for', () => {
    const plan = planCommand('import', { title: '  My  Song ', artist: 'Me', bpm: 128, density: 'hard', name: 'x.mp4' }, songs, '/tmp/upload');
    expect(plan).toEqual({
      args: ['import', '/tmp/upload', '--out', songs, '--title=My Song', '--artist=Me', '--bpm=128', '--density=hard'],
    });
  });

  it('names an import after its file when there is no title', () => {
    const plan = planCommand('import', { name: 'C:\\Music\\my_cool_song.mp4' }, songs, '/tmp/upload');
    expect(plan).toEqual({ args: ['import', '/tmp/upload', '--out', songs, '--title=my cool song'] });
    expect(titleFromFileName('a/b/Track 01.final.mp3')).toBe('Track 01.final');
    expect(titleFromFileName(undefined)).toBe('Untitled');
    expect(titleFromFileName('.mp3')).toBe('Untitled');
  });

  it('passes each value as one argument, so nothing can be taken for an option', () => {
    const plan = planCommand('import', { title: '--out=/etc', name: 'x' }, songs, '/tmp/upload');
    expect(plan).toEqual({ args: ['import', '/tmp/upload', '--out', songs, '--title=--out=/etc'] });
  });

  it('strips control characters from names', () => {
    const plan = planCommand('tune', { id: 'abc', title: 'a\nb\u0000c' }, songs);
    expect(plan).toEqual({ args: ['tune', 'abc', '--out', songs, '--title=a b c'] });
  });

  it('re-charts, tunes and removes', () => {
    expect(planCommand('rechart', { id: 'abc', bpm: 90, density: 'easy', auto: false }, songs)).toEqual({
      args: ['rechart', 'abc', '--out', songs, '--bpm=90', '--density=easy'],
    });
    expect(planCommand('rechart', { id: 'abc', auto: true }, songs)).toEqual({ args: ['rechart', 'abc', '--out', songs, '--auto'] });
    expect(planCommand('tune', { id: 'abc', nudgeMs: -20, title: 'New' }, songs)).toEqual({
      args: ['tune', 'abc', '--out', songs, '--title=New', '--nudge-ms=-20'],
    });
    expect(planCommand('remove', { id: 'abc' }, songs)).toEqual({ args: ['remove', 'abc', '--out', songs] });
  });

  it.each([
    ['an id with a slash', 'remove', { id: '../x' }],
    ['an id with capitals', 'remove', { id: 'Abc' }],
    ['a missing id', 'tune', {}],
    ['a very long id', 'rechart', { id: 'a'.repeat(65) }],
    ['a tempo that is too slow', 'rechart', { id: 'abc', bpm: 10 }],
    ['a tempo that is not a number', 'rechart', { id: 'abc', bpm: '120' }],
    ['a density that does not exist', 'rechart', { id: 'abc', density: 'insane' }],
    ['a nudge that is too big', 'tune', { id: 'abc', nudgeMs: 900 }],
    ['a title that is not text', 'tune', { id: 'abc', title: 5 }],
    ['something that is not an object', 'remove', 'abc'],
  ] as const)('refuses %s', (_name, action, input) => {
    expect(planCommand(action, input, '/songs')).toMatchObject({ status: 400 });
  });

  it('needs a file to import', () => {
    expect(planCommand('import', { title: 'x' }, '/songs')).toMatchObject({ status: 400 });
  });
});

describe('reading the analyser', () => {
  it('splits output into lines however it arrives', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\r\n\n{"c":3}')).toEqual(['{"b":2}', '']);
    expect(splitter.flush()).toEqual(['{"c":3}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('understands its events and drops anything else', () => {
    expect(parseEvent('{"event":"stage","stage":"a","message":"b"}')).toEqual({ event: 'stage', stage: 'a', message: 'b' });
    expect(parseEvent('{"event":"done","id":"x"}')).toEqual({ event: 'done', id: 'x' });
    expect(parseEvent('{"event":"error","message":"no"}')).toEqual({ event: 'error', message: 'no' });
    expect(parseEvent('{"event":"error"}')).toBeNull();
    expect(parseEvent('{"event":"mystery"}')).toBeNull();
    expect(parseEvent('warning: something')).toBeNull();
    expect(parseEvent('42')).toBeNull();
    expect(parseEvent('null')).toBeNull();
  });
});

describe('the handler, with a stand-in analyser', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    const handler = createSongsHandler({
      python: process.execPath,
      pythonArgs: [],
      script: fileURLToPath(new URL('./fixtures/fake-analyzer.mjs', import.meta.url)),
      songsFolder: join('fake', 'songs'),
      cwd: process.cwd(),
      maxUpload: 1000,
    });
    // (The dev server mounts the handler under /__songs.)
    server = createServer((req, res) => {
      req.url = (req.url ?? '').replace(/^\/__songs/, '');
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  interface Reply {
    status: number;
    events: AnalyzerEvent[];
    body: string;
  }

  function call(method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: `/__songs/${path}`,
          method,
          headers: { Host: `localhost:${port}`, 'X-Piano-Tiles': '1', ...headers },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AnalyzerEvent);
            resolve({ status: res.statusCode ?? 0, events, body: text });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  const json = (value: unknown) => JSON.stringify(value);
  const last = (reply: Reply) => reply.events[reply.events.length - 1] as Record<string, any>;

  it('says whether the tools are set up', async () => {
    const reply = await call('GET', 'status');
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ available: true });
  });

  it('gives the uploaded file to the analyser, streams its progress and cleans up', async () => {
    const reply = await call('POST', 'import?name=beat.mp4&title=Beat&bpm=120&density=easy', Buffer.alloc(500, 1));
    expect(reply.status).toBe(200);
    expect(reply.events.map((event) => event.event)).toEqual(['stage', 'done']);
    const done = last(reply);
    expect(done.upload.bytes).toBe(500);
    expect(done.echo.args).toEqual(['--out', join('fake', 'songs'), '--title=Beat', '--bpm=120', '--density=easy']);
    expect(existsSync(done.upload.path)).toBe(false); // the temporary copy is gone
  });

  it('passes on what the analyser refused, and a crash as a plain error', async () => {
    const refused = await call('POST', 'import?title=refuse', Buffer.alloc(10));
    expect(last(refused)).toEqual({ event: 'error', message: 'That does not sound like music.' });

    const crashed = await call('POST', 'import?title=crash', Buffer.alloc(10));
    expect(crashed.status).toBe(200);
    expect(last(crashed)).toMatchObject({ event: 'error' });
    expect(last(crashed).message).toContain('ValueError: boom');
  });

  it('never passes on output that is not one of its events', async () => {
    const reply = await call('POST', 'import?title=junk', Buffer.alloc(10));
    expect(reply.events.map((event) => event.event)).toEqual(['stage', 'done']);
  });

  it('runs the other actions from JSON', async () => {
    const tuned = await call('POST', 'tune', json({ id: 'abc', nudgeMs: 30 }), { 'Content-Type': 'application/json' });
    expect(last(tuned).echo).toMatchObject({ command: 'tune', target: 'abc', args: ['--out', join('fake', 'songs'), '--nudge-ms=30'] });
    const removed = await call('POST', 'remove', json({ id: 'abc' }));
    expect(last(removed).echo).toMatchObject({ command: 'remove', target: 'abc' });
  });

  it('turns away what is not the app', async () => {
    expect((await call('POST', 'remove', json({ id: 'abc' }), { 'X-Piano-Tiles': '0' })).status).toBe(403);
    expect((await call('POST', 'remove', json({ id: 'abc' }), { Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await call('POST', 'remove', json({ id: 'abc' }), { Host: 'evil.test' })).status).toBe(403);
  });

  it('refuses bad requests politely', async () => {
    expect((await call('POST', 'remove', json({ id: '../..' }))).status).toBe(400);
    expect((await call('POST', 'remove', 'not json')).status).toBe(400);
    expect((await call('POST', 'nothing', '{}')).status).toBe(404);
    expect((await call('GET', 'import')).status).toBe(405);
    expect((await call('POST', 'import', Buffer.alloc(0))).status).toBe(400);
    const tooBig = await call('POST', 'import?title=x', Buffer.alloc(1001));
    expect(tooBig.status).toBe(413);
    expect(last(tooBig)).toMatchObject({ event: 'error' });
  });

  it('does one job at a time', async () => {
    const first = call('POST', 'import?title=slow', Buffer.alloc(10));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await call('POST', 'remove', json({ id: 'abc' }));
    expect(second.status).toBe(409);
    expect((await first).events.map((event) => event.event)).toEqual(['stage', 'stage', 'done']);
    // ...and takes the next one once the first is over.
    expect((await call('POST', 'remove', json({ id: 'abc' }))).status).toBe(200);
  });
});
