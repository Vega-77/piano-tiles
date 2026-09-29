// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Analyser } from './analysis/client';
import type { Measured } from './analysis/analyze';
import { unpackSong } from './bundle';
import type { ChartFile } from './chart';
import { Cancelled, ImportError } from './errors';
import {
  addSong,
  exportSong,
  rechartSong,
  removeSong,
  slugify,
  titleFromFileName,
  tuneSong,
  uniqueId,
  type Stage,
  type Tools,
} from './importer';
import { createMemoryStore } from './store';
import { fakeDecoded, fakeFile } from './testing';

interface Heard {
  samples: number;
  options: Parameters<Analyser>[1];
}

/**
 * Tools with nothing real behind them: sound is a sine wave, and "analysing" answers straight away.
 * `cut` is where the fake analyser says a lap stops (like the real one, it always names the key,
 * and leaves it undefined for a song it plays whole).
 */
function setup(seconds = 10, cut?: number) {
  const store = createMemoryStore();
  const heard: Heard[] = [];
  const analyse: Analyser = async (samples, options, onProgress) => {
    heard.push({ samples: samples.length, options });
    onProgress?.({ stage: 'listen', message: 'Listening for hits', fraction: 0 });
    onProgress?.({ stage: 'chart', message: 'Placing the tiles', fraction: 1 });
    const result: Measured = {
      bpm: options.bpm ?? 120,
      rowsPerBeat: 2,
      offset: 0.1,
      duration: seconds,
      end: cut,
      difficulty: 3,
      chart: 'x . x . xx',
      analysis: {
        confidence: 0.9,
        drift: 0.01,
        manualBpm: options.bpm !== undefined,
        peakRate: 2,
        tiles: 3,
        rows: 20,
        density: 0.15,
        level: options.density,
        length: options.length,
        warnings: [],
      },
    };
    return result;
  };
  const tools: Tools = {
    store: async () => store,
    decoder: async () => fakeDecoded(seconds, { sampleRate: 22050 }),
    analyse,
  };
  return { store, heard, tools };
}

const saved = async (store: ReturnType<typeof setup>['store'], id: string) => (await store.chart(id)) as ChartFile;

describe('names and ids', () => {
  it('makes an id from a name', () => {
    expect(slugify('My Great Song!')).toBe('my-great-song');
    expect(slugify('  --Mötley Crüe--  ')).toBe('m-tley-cr-e');
    expect(slugify('日本語')).toBe('song');
    expect(slugify('a'.repeat(100)).length).toBe(48);
  });

  it('finds a free id', () => {
    expect(uniqueId('song', new Set())).toBe('song');
    expect(uniqueId('song', new Set(['song']))).toBe('song-2');
    expect(uniqueId('song', new Set(['song', 'song-2', 'song-3']))).toBe('song-4');
    expect(uniqueId('x'.repeat(64), new Set(['x'.repeat(60)])).length).toBeLessThanOrEqual(64);
  });

  it('takes a name from a file name', () => {
    expect(titleFromFileName('My_Great__Song.mp4')).toBe('My Great Song');
    expect(titleFromFileName('archive.tar.gz')).toBe('archive.tar');
    expect(titleFromFileName('.mp3')).toBe('Untitled');
    expect(titleFromFileName('no-extension')).toBe('no-extension');
  });
});

describe('adding a song from a recording', () => {
  it('saves its chart and its audio on this device, and returns the chart', async () => {
    const { store, heard, tools } = setup();
    const file = fakeFile(500, 'My_Great Song.mp3', 'audio/mpeg');
    const chart = await addSong(file, {}, {}, tools);

    expect(chart).toMatchObject({ id: 'my-great-song', title: 'My Great Song', artist: 'Imported', bpm: 120, difficulty: 3, duration: 10 });
    expect(chart.audio).toMatch(/^audio-[0-9a-f]{8}\.mp3$/);
    expect(chart.hue).toBeGreaterThanOrEqual(0);
    expect(chart.hue).toBeLessThan(360);
    expect(chart.hue2).toBe((chart.hue + 55) % 360);
    expect(await saved(store, 'my-great-song')).toEqual(chart);
    const audio = await store.audio('my-great-song');
    expect(audio!.size).toBe(500);
    expect(audio!.type).toBe('audio/mpeg');
    expect(heard).toHaveLength(1);
    expect(heard[0].samples).toBe(10 * 22050);
    expect(heard[0].options).toEqual({ density: 'medium', length: 'medium', bpm: undefined });
    expect('end' in chart).toBe(false); // (this song is short enough to play whole)
  });

  it('uses the name, artist, tempo, busyness and length it was given', async () => {
    const { heard, tools } = setup();
    const chart = await addSong(
      fakeFile(500, 'x.mp3'),
      { title: '  Mine  ', artist: ' Me ', bpm: 128, density: 'hard', length: 'long' },
      {},
      tools,
    );
    expect(chart).toMatchObject({ id: 'mine', title: 'Mine', artist: 'Me', bpm: 128 });
    expect(chart.analysis).toMatchObject({ manualBpm: true, level: 'hard', length: 'long' });
    expect(heard[0].options).toEqual({ density: 'hard', length: 'long', bpm: 128 });
  });

  it('saves where a long song was cut, and the whole length of its audio', async () => {
    const { store, tools } = setup(200, 76.1);
    const chart = await addSong(fakeFile(500, 'long.mp3'), {}, {}, tools);
    expect(chart).toMatchObject({ duration: 200, end: 76.1 });
    expect(await saved(store, chart.id)).toMatchObject({ duration: 200, end: 76.1 });
  });

  it('gives the same recording the same colours and audio name every time', async () => {
    const first = await addSong(fakeFile(500, 'a.mp3'), {}, {}, setup().tools);
    const second = await addSong(fakeFile(500, 'b.mp3'), {}, {}, setup().tools);
    expect(second.hue).toBe(first.hue);
    expect(second.audio).toBe(first.audio);
  });

  it('never reuses the id of a song already on the device', async () => {
    const { tools } = setup();
    const ids = [];
    for (const name of ['Song.mp3', 'Song.mp3', 'song.mp3', 'Other.mp3']) {
      ids.push((await addSong(fakeFile(500, name), {}, {}, tools)).id);
    }
    expect(ids).toEqual(['song', 'song-2', 'song-3', 'other']);
  });

  it('keeps a video’s sound as a WAV, not the video', async () => {
    const { store, tools } = setup(6);
    const chart = await addSong(fakeFile(5000, 'clip.mp4', 'video/mp4'), {}, {}, tools);
    expect(chart.audio).toMatch(/\.wav$/);
    const audio = await store.audio(chart.id);
    expect(audio!.type).toBe('audio/wav');
    expect(audio!.size).toBe(44 + 6 * 22050 * 2 * 2);
  });

  it('reports each step and finishes at the end of the bar', async () => {
    const { tools } = setup();
    const stages: Stage[] = [];
    await addSong(fakeFile(500, 'a.mp3'), {}, { onStage: (stage) => stages.push(stage) }, tools);
    expect(stages.length).toBeGreaterThan(4);
    expect(stages.every((stage, i) => i === 0 || stage.fraction >= stages[i - 1].fraction - 1e-9)).toBe(true);
    expect(stages.at(-1)).toEqual({ message: 'Done', fraction: 1 });
    expect(stages.map((stage) => stage.message)).toContain('Placing the tiles');
  });

  it('turns away an empty file, a huge one and an impossible tempo before doing any work', async () => {
    const { heard, tools } = setup();
    const decoder = tools.decoder;
    let decoded = 0;
    tools.decoder = async (bytes) => {
      decoded++;
      return decoder(bytes);
    };
    await expect(addSong(fakeFile(0, 'a.mp3'), {}, {}, tools)).rejects.toThrow(/empty/);
    const huge = { size: 301 * 1024 * 1024, name: 'huge.mp4' } as File;
    await expect(addSong(huge, {}, {}, tools)).rejects.toThrow(/300 MB/);
    for (const bpm of [10, 1000, Number.NaN]) {
      await expect(addSong(fakeFile(500, 'a.mp3'), { bpm }, {}, tools)).rejects.toThrow(/between 40 and 300/);
    }
    expect(decoded).toBe(0);
    expect(heard).toHaveLength(0);
  });

  it('saves nothing if the audio cannot be read or the song cannot be charted', async () => {
    const { store, tools } = setup();
    tools.decoder = async () => {
      throw new DOMException('nope', 'EncodingError');
    };
    await expect(addSong(fakeFile(500, 'a.mp3'), {}, {}, tools)).rejects.toBeInstanceOf(ImportError);

    const second = setup();
    second.tools.analyse = async () => {
      throw new ImportError('That does not sound like music.');
    };
    await expect(addSong(fakeFile(500, 'a.mp3'), {}, {}, second.tools)).rejects.toThrow('That does not sound like music.');
    expect(await store.charts()).toEqual([]);
    expect(await second.store.charts()).toEqual([]);
  });

  it('saves nothing when it is cancelled', async () => {
    const { store, tools } = setup();
    const controller = new AbortController();
    const analyse = tools.analyse;
    tools.analyse = async (...args) => {
      const result = await analyse(...args);
      controller.abort(); // (the player pressed Cancel just as the analysis finished)
      return result;
    };
    await expect(addSong(fakeFile(500, 'a.mp3'), {}, { signal: controller.signal }, tools)).rejects.toBeInstanceOf(Cancelled);
    expect(await store.charts()).toEqual([]);
  });
});

describe('changing a saved song', () => {
  async function withSong(title = 'Demo') {
    const context = setup();
    const chart = await addSong(fakeFile(500, `${title}.mp3`), { bpm: 100 }, {}, context.tools);
    context.heard.length = 0;
    return { ...context, chart };
  }

  it('re-charts with the tempo and busyness asked for, keeping the name, colours, audio and nudge', async () => {
    const { store, heard, tools, chart } = await withSong();
    await tuneSong(chart.id, { title: 'Renamed', nudgeMs: 40 }, {}, tools);
    const again = await rechartSong(chart.id, { bpm: 90, density: 'easy' }, {}, tools);

    expect(heard[0].options).toEqual({ density: 'easy', length: 'medium', bpm: 90 });
    expect(again).toMatchObject({ id: chart.id, title: 'Renamed', hue: chart.hue, hue2: chart.hue2, audio: chart.audio, nudge: 0.04, bpm: 90 });
    expect(await saved(store, chart.id)).toEqual(again);
    expect((await store.audio(chart.id))!.size).toBe(500);
  });

  it('remembers a tempo given by hand, unless told to detect it again', async () => {
    const { heard, tools, chart } = await withSong();
    await rechartSong(chart.id, { density: 'hard' }, {}, tools);
    expect(heard[0].options).toEqual({ density: 'hard', length: 'medium', bpm: 100 });
    await rechartSong(chart.id, { auto: true }, {}, tools);
    expect(heard[1].options.bpm).toBeUndefined();
  });

  it('keeps the busyness it had unless asked for another', async () => {
    const { heard, tools, chart } = await withSong();
    await rechartSong(chart.id, { density: 'easy' }, {}, tools);
    await rechartSong(chart.id, {}, {}, tools);
    expect(heard[1].options.density).toBe('easy');
  });

  it('keeps the length it had unless asked for another', async () => {
    const { heard, tools, chart } = await withSong();
    await rechartSong(chart.id, { length: 'short' }, {}, tools);
    await rechartSong(chart.id, {}, {}, tools);
    await rechartSong(chart.id, { length: 'long' }, {}, tools);
    expect(heard.map((entry) => entry.options.length)).toEqual(['short', 'short', 'long']);
  });

  it('reads a song saved before there were lengths as a medium one', async () => {
    const { store, heard, tools, chart } = await withSong();
    const { length: _length, ...analysis } = (await saved(store, chart.id)).analysis!;
    await store.save({ ...(await saved(store, chart.id)), analysis });
    await rechartSong(chart.id, {}, {}, tools);
    expect(heard[0].options.length).toBe('medium');
  });

  it('puts the cut where the new analysis says, and drops an old one when there is none', async () => {
    const context = setup(200, 76.1);
    const chart = await addSong(fakeFile(500, 'long.mp3'), { bpm: 100 }, {}, context.tools);
    expect(chart.end).toBe(76.1);

    // The same song, charted again as a short one: a new cut.
    const cutAgain = setup(200, 61.3);
    await cutAgain.store.save(chart, await context.store.audio(chart.id) ?? undefined);
    expect((await rechartSong(chart.id, { length: 'short' }, {}, cutAgain.tools)).end).toBe(61.3);

    // ...and charted again where it fits whole: the old cut must not stay behind.
    const whole = setup(200);
    await whole.store.save(chart, await context.store.audio(chart.id) ?? undefined);
    const wholeAgain = await rechartSong(chart.id, { length: 'long' }, {}, whole.tools);
    expect(wholeAgain.end).toBeUndefined();
    expect((await saved(whole.store, chart.id)).end).toBeUndefined();
  });

  it('says so when the song or its audio is gone', async () => {
    const { store, tools, chart } = await withSong();
    await expect(rechartSong('nothing', {}, {}, tools)).rejects.toThrow(/no longer on this device/);
    await store.save({ ...chart, id: 'lost' });
    await expect(rechartSong('lost', {}, {}, tools)).rejects.toThrow(/audio is no longer/);
  });

  it('renames, without any analysis, and can change the artist', async () => {
    const { store, heard, tools, chart } = await withSong();
    const tuned = await tuneSong(chart.id, { title: '  New name ', artist: ' Someone ' }, {}, tools);
    expect(tuned).toMatchObject({ title: 'New name', artist: 'Someone' });
    expect((await saved(store, chart.id)).title).toBe('New name');
    expect(heard).toHaveLength(0);
    expect((await tuneSong(chart.id, { artist: '  ' }, {}, tools)).artist).toBe('Imported');
    await expect(tuneSong(chart.id, { title: '   ' }, {}, tools)).rejects.toThrow(/needs a name/);
  });

  it('moves the audio against the tiles by up to half a second, and zero puts it back', async () => {
    const { store, tools, chart } = await withSong();
    expect((await tuneSong(chart.id, { nudgeMs: -35.5 }, {}, tools)).nudge).toBe(-0.0355);
    expect((await saved(store, chart.id)).nudge).toBe(-0.0355);
    const back = await tuneSong(chart.id, { nudgeMs: 0 }, {}, tools);
    expect(back.nudge).toBeUndefined();
    expect('nudge' in (await saved(store, chart.id))).toBe(false);
    await expect(tuneSong(chart.id, { nudgeMs: 501 }, {}, tools)).rejects.toThrow(/at most 500 ms/);
    await expect(tuneSong(chart.id, { nudgeMs: Number.NaN }, {}, tools)).rejects.toThrow(/at most 500 ms/);
    expect((await store.audio(chart.id))!.size).toBe(500);
  });

  it('removes a song and its audio', async () => {
    const { store, tools, chart } = await withSong();
    await removeSong(chart.id, {}, tools);
    expect(await store.charts()).toEqual([]);
    expect(await store.audio(chart.id)).toBeUndefined();
  });
});

describe('moving a song to another device', () => {
  async function exported() {
    const { store, tools } = setup();
    const chart = await addSong(fakeFile(500, 'Road Trip.mp3', 'audio/mpeg'), {}, {}, tools);
    await tuneSong(chart.id, { nudgeMs: 25 }, {}, tools);
    const { blob, filename } = await exportSong(chart.id, tools);
    return { store, tools, blob, filename, chart: await saved(store, chart.id) };
  }

  it('exports the chart and audio as one file named after the song', async () => {
    const { blob, filename, chart } = await exported();
    expect(filename).toBe('road-trip.pianotiles');
    const opened = await unpackSong(blob);
    expect(opened.chart).toEqual(chart);
    expect(opened.audio.size).toBe(500);
  });

  it('adds that file on a device that has nothing, exactly as it was, without listening to it again', async () => {
    const { blob, filename, chart } = await exported();
    const other = setup();
    const added = await addSong(new File([blob], filename), {}, {}, other.tools);
    expect(added).toEqual(chart);
    expect(await saved(other.store, chart.id)).toEqual(chart);
    expect((await other.store.audio(chart.id))!.size).toBe(500);
    expect(other.heard).toHaveLength(0);
  });

  it('replaces the same song when its file is added again', async () => {
    const { store, tools, blob, filename, chart } = await exported();
    await tuneSong(chart.id, { title: 'Changed since' }, {}, tools);
    const added = await addSong(new File([blob], filename), {}, {}, tools);
    expect(added.id).toBe(chart.id);
    expect(added.title).toBe(chart.title);
    expect(await store.charts()).toHaveLength(1);
  });

  it('gives a different song with the same id an id of its own', async () => {
    const { blob, filename, chart } = await exported();
    const other = setup();
    await other.store.save({ ...chart, audio: 'audio-ffffffff.mp3', title: 'Someone else’s' }, new Blob(['x']));
    const added = await addSong(new File([blob], filename), {}, {}, other.tools);
    expect(added.id).toBe('road-trip-2');
    expect(await other.store.charts()).toHaveLength(2);
    expect((await saved(other.store, chart.id)).title).toBe('Someone else’s');
  });

  it('refuses a song file that is damaged', async () => {
    const { blob, filename } = await exported();
    const cut = blob.slice(0, blob.size - 10);
    await expect(addSong(new File([cut], filename), {}, {}, setup().tools)).rejects.toThrow(/cut short/);
  });

  it('will not export a song that is gone', async () => {
    await expect(exportSong('nothing', setup().tools)).rejects.toBeInstanceOf(ImportError);
  });
});
