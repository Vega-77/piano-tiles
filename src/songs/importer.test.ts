// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ChartFile } from './chart';
import { checkTools, ImportError, importSong, lineSplitter, readJob, rechartSong, removeSong, tuneSong, type Stage } from './importer';

const base = 'http://localhost:5173/';
const encoder = new TextEncoder();

function chart(overrides: Partial<ChartFile> = {}): ChartFile {
  return {
    version: 1,
    id: 'demo',
    title: 'Demo',
    artist: 'Imported',
    audio: 'audio-1a2b3c4d.mp3',
    bpm: 120,
    rowsPerBeat: 2,
    offset: 0.1,
    duration: 30,
    difficulty: 2,
    hue: 200,
    hue2: 255,
    chart: 'x . x .',
    ...overrides,
  };
}

const line = (event: unknown) => `${JSON.stringify(event)}\n`;

/** A response that arrives in the given pieces, so a test can cut it wherever it likes. */
function streamed(pieces: (string | Uint8Array)[], status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece);
        controller.close();
      },
    }),
    { status },
  );
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetcher };
}

const done = (c: ChartFile) => line({ event: 'done', chart: c });

describe('splitting lines', () => {
  it('holds back a line until it is whole', () => {
    const lines = lineSplitter();
    expect(lines.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(':2}\r\n')).toEqual(['{"b":2}']);
    expect(lines.push('tail')).toEqual([]);
    expect(lines.flush()).toEqual(['tail']);
    expect(lines.flush()).toEqual([]);
  });
});

describe('reading a job', () => {
  it('reports each stage and returns the done event', async () => {
    const stages: Stage[] = [];
    const response = streamed([
      line({ event: 'stage', stage: 'convert', message: 'Converting the audio' }),
      line({ event: 'stage', stage: 'grid', message: 'Finding the beat' }),
      line({ event: 'done', id: 'x' }),
    ]);
    expect(await readJob(response, (stage) => stages.push(stage))).toEqual({ event: 'done', id: 'x' });
    expect(stages).toEqual([
      { stage: 'convert', message: 'Converting the audio' },
      { stage: 'grid', message: 'Finding the beat' },
    ]);
  });

  it('copes with lines cut anywhere, even through a character', async () => {
    const text = line({ event: 'stage', stage: 's', message: 'Listening – très bien 🎵' }) + line({ event: 'done', ok: true });
    const bytes = encoder.encode(text);
    const stages: Stage[] = [];
    // One byte at a time is the worst case: every multi-byte character is cut.
    const pieces = Array.from(bytes, (byte) => new Uint8Array([byte]));
    expect(await readJob(streamed(pieces), (stage) => stages.push(stage))).toEqual({ event: 'done', ok: true });
    expect(stages[0].message).toBe('Listening – très bien 🎵');
  });

  it('takes a last line that has no line break', async () => {
    expect(await readJob(streamed(['{"event":"done","id":"x"}']))).toEqual({ event: 'done', id: 'x' });
  });

  it('turns an error event into an ImportError with the analyser’s words', async () => {
    const response = streamed([line({ event: 'stage', stage: 'a', message: 'b' }), line({ event: 'error', message: 'That does not sound like music.' })]);
    await expect(readJob(response)).rejects.toThrow('That does not sound like music.');
    await expect(readJob(streamed([line({ event: 'error', message: 'No.' })], 409))).rejects.toBeInstanceOf(ImportError);
  });

  it('says so when the connection ends early, or when the server has no such door', async () => {
    await expect(readJob(streamed([line({ event: 'stage', stage: 'a', message: 'b' })]))).rejects.toThrow(/closed before/);
    await expect(readJob(streamed(['<html>Cannot POST</html>'], 404))).rejects.toThrow(/npm run dev/);
    await expect(readJob(streamed([], 502))).rejects.toThrow(/502/);
  });

  it('ignores lines that are not events', async () => {
    const response = streamed(['warning: something\n', 'null\n', '42\n', line({ event: 'mystery' }), line({ event: 'done', id: 'x' })]);
    expect(await readJob(response)).toEqual({ event: 'done', id: 'x' });
  });
});

describe('importing a song', () => {
  const file = new File([new Uint8Array(100)], 'My Song.mp4', { type: 'video/mp4' });

  it('posts the file to the dev server with what was asked for, and returns the chart', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([line({ event: 'stage', stage: 'x', message: 'Working' }), done(chart())]));
    const stages: Stage[] = [];
    const result = await importSong(file, { title: ' Mine ', bpm: 128, density: 'hard', artist: '' }, { fetcher, base, onStage: (s) => stages.push(s) });

    expect(result).toEqual(chart());
    expect(stages).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('http://localhost:5173/__songs/import');
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: 'My Song.mp4', title: 'Mine', bpm: '128', density: 'hard' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(file);
    expect((calls[0].init.headers as Record<string, string>)['X-Piano-Tiles']).toBe('1');
  });

  it('leaves out what was not given, so the analyser decides', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([done(chart())]));
    await importSong(file, {}, { fetcher, base });
    expect(Object.fromEntries(new URL(calls[0].url).searchParams)).toEqual({ name: 'My Song.mp4' });
  });

  it('refuses an empty file, or one that is too big, without sending it', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([done(chart())]));
    await expect(importSong(new File([], 'a.mp3'), {}, { fetcher, base })).rejects.toThrow(/empty/);
    const huge = { size: 301 * 1024 * 1024, name: 'huge.mp4' } as File;
    await expect(importSong(huge, {}, { fetcher, base })).rejects.toThrow(/300 MB/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a chart the app could not play', async () => {
    const { fetcher } = fakeFetch(() => streamed([line({ event: 'done', chart: { ...chart(), bpm: 9000 } })]));
    await expect(importSong(file, {}, { fetcher, base })).rejects.toThrow(/Bad chart/);
  });

  it('explains a dev server that cannot be reached', async () => {
    const fetcher = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(importSong(file, {}, { fetcher, base })).rejects.toThrow(/npm run dev/);
  });

  it('says it was cancelled when it was', async () => {
    const controller = new AbortController();
    const fetcher = (async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    await expect(importSong(file, {}, { fetcher, base, signal: controller.signal })).rejects.toThrow('Cancelled.');
  });
});

describe('changing a saved song', () => {
  it('re-charts, with the tempo and busyness asked for', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([done(chart({ bpm: 90 }))]));
    const result = await rechartSong('demo', { bpm: 90, density: 'easy' }, { fetcher, base });
    expect(result.bpm).toBe(90);
    expect(new URL(calls[0].url).pathname).toBe('/__songs/rechart');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ id: 'demo', bpm: 90, density: 'easy' });
    expect((calls[0].init.headers as Record<string, string>)['X-Piano-Tiles']).toBe('1');
  });

  it('tunes the name and the sync nudge', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([done(chart({ nudge: 0.03 }))]));
    expect((await tuneSong('demo', { title: 'New', nudgeMs: 30 }, { fetcher, base })).nudge).toBe(0.03);
    expect(new URL(calls[0].url).pathname).toBe('/__songs/tune');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ id: 'demo', title: 'New', nudgeMs: 30 });
  });

  it('removes a song', async () => {
    const { calls, fetcher } = fakeFetch(() => streamed([line({ event: 'done', id: 'demo' })]));
    await removeSong('demo', { fetcher, base });
    expect(new URL(calls[0].url).pathname).toBe('/__songs/remove');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ id: 'demo' });
  });
});

describe('checking the tools', () => {
  it('says whether the analyser is set up', async () => {
    const ready = fakeFetch(() => Response.json({ available: true }));
    expect(await checkTools({ fetcher: ready.fetcher, base })).toEqual({ available: true, message: undefined });
    expect((ready.calls[0].init.headers as Record<string, string>)['X-Piano-Tiles']).toBe('1');

    const missing = fakeFetch(() => Response.json({ available: false, message: 'Run setup.' }));
    expect(await checkTools({ fetcher: missing.fetcher, base })).toEqual({ available: false, message: 'Run setup.' });
  });

  it('says so on a build with no dev server, or one that cannot be reached', async () => {
    const notFound = fakeFetch(() => new Response('nope', { status: 404 }));
    expect((await checkTools({ fetcher: notFound.fetcher, base })).available).toBe(false);
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect((await checkTools({ fetcher: down, base })).available).toBe(false);
  });
});
