import { beforeAll, describe, expect, it } from 'vitest';
import { movingAverage, percentile, resampleMono } from './dsp';
import { AnalysisError, DENSITIES, MAX_SECONDS, analyze, hueOf, type Measured } from './analyze';
import { SAMPLE_RATE, computeFeatures } from './features';
import { MAX_ROWS_PER_SECOND, MIN_ROWS_PER_SECOND, pickRowsPerBeat, rowsPerBeatForBpm } from './grid';
import { synthForAnalysis } from './synth';
import { DENSITY } from './tiles';

/**
 * These run the analyser on songs made here, where the true tempo and the first beat are known, so
 * a change that breaks the timing fails a test rather than a song.
 */

const SLOW = 60_000;
const rowsPerSecond = (chart: Measured) => (chart.bpm * chart.rowsPerBeat) / 60;

/** (relative tempo error of the row grid against the nearest multiple of the true beat, phase error in ms). */
function gridError(chart: Measured, bpm: number, offset: number): { tempo: number; phase: number } {
  const rate = rowsPerSecond(chart);
  const truth = bpm / 60;
  const multiple = rate >= truth ? Math.max(1, Math.round(rate / truth)) : 1 / Math.round(truth / rate);
  const row = 1 / rate;
  const diff = (((chart.offset - offset) % row) + row) % row;
  return { tempo: Math.abs(rate / (truth * multiple) - 1), phase: Math.min(diff, row - diff) * 1000 };
}

const NORMAL = { density: 'normal' } as const;

describe('the analyser on made-up songs', () => {
  const songs: Record<string, { bpm: number; offset: number; seconds: number; samples?: Float32Array }> = {
    a: { bpm: 120, offset: 0.37, seconds: 45 },
    b: { bpm: 97, offset: 0.12, seconds: 75 },
    c: { bpm: 140, offset: 0.0, seconds: 40 },
    d: { bpm: 85, offset: 0.61, seconds: 50 },
  };

  beforeAll(async () => {
    for (const [name, song] of Object.entries(songs)) {
      song.samples = await synthForAnalysis({ ...song, seed: song.bpm });
      expect(song.samples.length, name).toBeGreaterThan(SAMPLE_RATE * 30);
    }
  }, SLOW);

  for (const key of ['a', 'b', 'c', 'd']) {
    const song = songs[key];
    it(`finds ${song.bpm} BPM with the first beat at ${song.offset}s`, () => {
      const chart = analyze(song.samples!, NORMAL);
      const error = gridError(chart, song.bpm, song.offset);
      const analysis = chart.analysis!;
      expect(error.tempo).toBeLessThan(0.002);
      expect(error.phase).toBeLessThan(8);
      expect(analysis.confidence).toBeGreaterThan(0.6);
      expect(analysis.drift).toBeLessThan(0.03);
      expect(analysis.warnings).toEqual([]);
      expect(analysis.tiles).toBeGreaterThanOrEqual(20);
      expect(analysis.tiles).toBeLessThanOrEqual(analysis.rows);
      expect(rowsPerSecond(chart)).toBeGreaterThanOrEqual(MIN_ROWS_PER_SECOND);
      expect(rowsPerSecond(chart)).toBeLessThanOrEqual(MAX_ROWS_PER_SECOND);
      expect(chart.duration).toBeCloseTo(song.seconds, 1);
    }, SLOW);
  }

  it('copes with a human band, every player about 10 ms off the beat', async () => {
    const samples = await synthForAnalysis({ bpm: 104, offset: 0.29, seconds: 60, seed: 7, jitter: 0.01 });
    const chart = analyze(samples, NORMAL);
    const error = gridError(chart, 104, 0.29);
    expect(error.tempo).toBeLessThan(0.003);
    expect(error.phase).toBeLessThan(15);
    expect(chart.analysis!.confidence).toBeGreaterThan(0.4);
    expect(chart.analysis!.warnings).toEqual([]);
  }, SLOW);

  it('warns about a tempo that speeds up over the song', async () => {
    const samples = await synthForAnalysis({ bpm: 100, offset: 0.2, seconds: 90, seed: 3, warp: 0.005 });
    const chart = analyze(samples, NORMAL);
    expect(chart.analysis!.warnings!.some((warning) => warning.includes('drifts'))).toBe(true);
  }, SLOW);

  it('refines a tempo given by hand a few BPM off to the true grid', () => {
    const chart = analyze(songs.a.samples!, { ...NORMAL, bpm: 118 });
    const error = gridError(chart, 120, 0.37);
    expect(chart.analysis!.manualBpm).toBe(true);
    expect(error.tempo).toBeLessThan(0.002);
    expect(error.phase).toBeLessThan(20);
  }, SLOW);

  it('puts more tiles in at each density', () => {
    const [easy, normal, hard] = DENSITIES.map((density) => analyze(songs.b.samples!, { density }).analysis!.tiles);
    expect(easy).toBeLessThan(normal);
    expect(normal).toBeLessThan(hard);
  }, SLOW);

  it('puts the tiles on the drums, not between them', () => {
    const chart = analyze(songs.a.samples!, NORMAL);
    const beat = 60 / 120;
    const row = beat / chart.rowsPerBeat;
    let position = 0;
    let onBeat = 0;
    let total = 0;
    for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
      if (token.startsWith('.')) {
        position += token.length > 1 ? Number(token.slice(1)) : 1;
        continue;
      }
      total++;
      const beats = (chart.offset + position * row - 0.37) / beat;
      if (Math.abs(beats - Math.round(beats)) < 0.1) onBeat++;
      position += token.startsWith('x~') ? Number(token.slice(2)) : 1;
    }
    expect(onBeat / total).toBeGreaterThan(0.7);
  }, SLOW);

  describe('a song with quiet verses and a loud chorus', () => {
    const verse = (time: number) => time % 32 < 16;
    let samples: Float32Array;
    beforeAll(async () => {
      samples = await synthForAnalysis({ bpm: 120, offset: 0.2, seconds: 96, seed: 5, verse });
    }, SLOW);

    /** Tiles that start in the verses and in the choruses. */
    function share(chart: Measured): { verse: number; chorus: number } {
      const rate = rowsPerSecond(chart);
      const out = { verse: 0, chorus: 0 };
      let position = 0;
      for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
        if (token !== '.') out[verse(chart.offset + position / rate) ? 'verse' : 'chorus']++;
        position += token.startsWith('x~') ? Number(token.slice(2)) : 1;
      }
      return out;
    }

    for (const density of DENSITIES) {
      it(`does not leave the verses bare on ${density}, and still makes the chorus busier`, () => {
        const { verse: quiet, chorus: loud } = share(analyze(samples, { density }));
        expect(quiet).toBeGreaterThan(0.3 * loud);
        expect(loud).toBeGreaterThan(quiet);
      }, SLOW);
    }

    it('keeps the difficulties: the same number of tiles, wherever they fall', () => {
      const tiles = DENSITIES.map((density) => analyze(samples, { density }).analysis!.tiles);
      const rows = analyze(samples, NORMAL).analysis!.rows;
      tiles.forEach((count, i) => expect(count).toBeGreaterThan(0.95 * Math.trunc(DENSITY[DENSITIES[i]].fraction * rows)));
      expect(tiles[0]).toBeLessThan(tiles[1]);
      expect(tiles[1]).toBeLessThan(tiles[2]);
    }, SLOW);

    it('leaves a silent stretch bare rather than filling it with noise', async () => {
      const gap = (time: number) => time >= 40 && time < 56;
      const song = await synthForAnalysis({ bpm: 120, offset: 0.2, seconds: 96, seed: 5, verse, silent: gap });
      const chart = analyze(song, NORMAL);
      const rate = rowsPerSecond(chart);
      let inGap = 0;
      let position = 0;
      for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
        const time = chart.offset + position / rate;
        if (token !== '.' && time >= 41 && time < 55) inGap++; // (a kick's tail runs a little past the gap's edges)
        position += token.startsWith('x~') ? Number(token.slice(2)) : 1;
      }
      expect(inGap).toBe(0);
    }, SLOW);
  });

  it('is deterministic, and writes a chart the game can read', () => {
    const first = analyze(songs.c.samples!, NORMAL);
    const second = analyze(songs.c.samples!, NORMAL);
    expect(second).toEqual(first);
    expect(first.difficulty).toBeGreaterThanOrEqual(1);
    expect(first.difficulty).toBeLessThanOrEqual(5);
    expect(first.chart.split(/\s+/).every((token) => /^(x|xx|x~[2-4]|\.)$/.test(token))).toBe(true);
  }, SLOW);

  it('reports how far along it is, ending at 1', () => {
    const seen: number[] = [];
    analyze(songs.d.samples!, NORMAL, (progress) => {
      if (progress.fraction !== undefined) seen.push(progress.fraction);
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1] - 1e-9)).toBe(true);
  }, SLOW);

  it('gives the same colours to the same song, and different ones to different songs', () => {
    expect(hueOf(songs.a.samples!)).toBe(hueOf(songs.a.samples!));
    expect(hueOf(songs.a.samples!)).not.toBe(hueOf(songs.b.samples!));
    expect(hueOf(songs.a.samples!)).toBeGreaterThanOrEqual(0);
    expect(hueOf(songs.a.samples!)).toBeLessThan(360);
  });
});

describe('audio that cannot be charted', () => {
  it('refuses silence politely', () => {
    expect(() => analyze(new Float32Array(SAMPLE_RATE * 20), NORMAL)).toThrow(AnalysisError);
  });

  it('refuses audio that is too short', () => {
    expect(() => analyze(new Float32Array(SAMPLE_RATE * 2), NORMAL)).toThrow(/too short/);
  });

  it('refuses a song that is too long', () => {
    expect(() => analyze(new Float32Array(SAMPLE_RATE * (MAX_SECONDS + 1)), NORMAL)).toThrow(/minutes long/);
  });
});

describe('tempo helpers', () => {
  it('picks rows per beat so the tempo reads like a real one', () => {
    expect(pickRowsPerBeat(4)).toEqual({ rowsPerBeat: 2, bpm: 120 });
    expect(pickRowsPerBeat(3.2)).toEqual({ rowsPerBeat: 2, bpm: 96 });
    const slow = pickRowsPerBeat(2.5);
    expect(slow.bpm * slow.rowsPerBeat).toBeCloseTo(150, 5);
  });

  it('picks the rows per beat that lands nearest four rows a second for a hand-entered tempo', () => {
    expect(rowsPerBeatForBpm(120)).toBe(2);
    expect(rowsPerBeatForBpm(60)).toBe(4);
    expect(rowsPerBeatForBpm(240)).toBe(1);
  });
});

describe('signal helpers', () => {
  it('resamples without moving anything in time', async () => {
    const from = 44100;
    const tone = Float32Array.from({ length: from * 2 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / from));
    const out = await resampleMono([tone], from, SAMPLE_RATE);
    expect(out.length).toBe(SAMPLE_RATE * 2);
    for (const at of [1000, 10_000, 30_000]) {
      expect(out[at]).toBeCloseTo(Math.sin((2 * Math.PI * 440 * at) / SAMPLE_RATE), 2);
    }
  });

  it('mixes channels down and keeps a click where it was', async () => {
    const left = new Float32Array(44100);
    const right = new Float32Array(44100);
    left[22050] = 1;
    right[22050] = 1;
    const out = await resampleMono([left, right], 44100, SAMPLE_RATE);
    let peak = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
    expect(peak).toBe(11025);
  });

  it('smooths with a centred window, and finds percentiles between values', () => {
    expect(Array.from(movingAverage(Float64Array.from([1, 1, 4, 1, 1]), 3))).toEqual([1, 2, 2, 2, 1]);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([5], 90)).toBe(5);
  });

  it('hears a click as a jump in the envelope at its time', () => {
    const samples = new Float32Array(SAMPLE_RATE * 2);
    for (let i = 0; i < 2000; i++) samples[SAMPLE_RATE + i] = Math.sin(i * 0.3) * Math.exp(-i / 400);
    const features = computeFeatures(samples);
    let peak = 0;
    for (let i = 0; i < features.env.length; i++) if (features.env[i] > features.env[peak]) peak = i;
    expect(peak / (SAMPLE_RATE / 128)).toBeCloseTo(1, 1);
    expect(features.duration).toBe(2);
  });
});
