import { beforeAll, describe, expect, it } from 'vitest';
import { movingAverage, percentile, resampleMono } from './dsp';
import { AnalysisError, DENSITIES, MAX_SECONDS, analyze, hueOf, type Measured } from './analyze';
import { ENV_LAG, FPS, SAMPLE_RATE, computeFeatures, type Features } from './features';
import { MAX_ROWS_PER_SECOND, MIN_ROWS_PER_SECOND, pickRowsPerBeat, rowsPerBeatForBpm, type Grid } from './grid';
import { LENGTHS, LENGTH_SECONDS } from './length';
import { synthForAnalysis } from './synth';
import { DEFAULT_DENSITY, DENSITY, beatOffset, densityFrom } from './tiles';

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

const MEDIUM = { density: 'medium' } as const;

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
      const chart = analyze(song.samples!, MEDIUM);
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
    const chart = analyze(samples, MEDIUM);
    const error = gridError(chart, 104, 0.29);
    expect(error.tempo).toBeLessThan(0.003);
    expect(error.phase).toBeLessThan(15);
    expect(chart.analysis!.confidence).toBeGreaterThan(0.4);
    expect(chart.analysis!.warnings).toEqual([]);
  }, SLOW);

  it('warns about a tempo that speeds up over the song', async () => {
    const samples = await synthForAnalysis({ bpm: 100, offset: 0.2, seconds: 90, seed: 3, warp: 0.005 });
    const chart = analyze(samples, MEDIUM);
    expect(chart.analysis!.warnings!.some((warning) => warning.includes('drifts'))).toBe(true);
  }, SLOW);

  it('refines a tempo given by hand a few BPM off to the true grid', () => {
    const chart = analyze(songs.a.samples!, { ...MEDIUM, bpm: 118 });
    const error = gridError(chart, 120, 0.37);
    expect(chart.analysis!.manualBpm).toBe(true);
    expect(error.tempo).toBeLessThan(0.002);
    expect(error.phase).toBeLessThan(20);
  }, SLOW);

  it('puts more tiles in at each density', () => {
    const [easy, medium, hard] = DENSITIES.map((density) => analyze(songs.b.samples!, { density }).analysis!.tiles);
    expect(easy).toBeLessThan(medium);
    expect(medium).toBeLessThan(hard);
  }, SLOW);

  describe('doubles', () => {
    const tokensOf = (chart: Measured) => chart.chart.split(/\s+/).filter(Boolean);
    const shareOfDoubles = (chart: Measured) => {
      const tiles = tokensOf(chart).filter((token) => token !== '.');
      return tiles.filter((token) => token === 'xx').length / tiles.length;
    };

    for (const density of DENSITIES) {
      it(`are a real part of ${density}, and never more than its cap`, () => {
        const share = shareOfDoubles(analyze(songs.b.samples!, { density }));
        expect(share).toBeGreaterThanOrEqual(0.8 * DENSITY[density].doubles);
        expect(share).toBeLessThanOrEqual(DENSITY[density].doubles + 1e-9);
      }, SLOW);
    }

    it('grow with the level, and come more often than one tile in ten from Medium up', () => {
      const [easy, medium, hard] = DENSITIES.map((density) => shareOfDoubles(analyze(songs.a.samples!, { density })));
      expect(easy).toBeGreaterThan(0.08);
      expect(medium).toBeGreaterThan(easy);
      expect(hard).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(0.15);
    }, SLOW);

    it('are spread through the song, not gathered in one place', () => {
      const chart = analyze(songs.b.samples!, MEDIUM);
      const quarter = chart.analysis!.rows / 4;
      const inQuarter = [0, 0, 0, 0];
      let position = 0;
      for (const token of tokensOf(chart)) {
        if (token === 'xx') inQuarter[Math.min(3, Math.trunc(position / quarter))]++;
        position += token.includes('~') ? Number(token.split('~')[1]) : token.startsWith('.') && token.length > 1 ? Number(token.slice(1)) : 1;
      }
      for (const count of inQuarter) expect(count).toBeGreaterThan(0);
    }, SLOW);

    it('never sit on two rows in a row', () => {
      for (const density of DENSITIES) {
        const tokens = tokensOf(analyze(songs.b.samples!, { density }));
        for (let i = 1; i < tokens.length; i++) expect(tokens[i] === 'xx' && tokens[i - 1] === 'xx').toBe(false);
      }
    }, SLOW);
  });

  describe('double holds', () => {
    /** Where each hold and double hold starts (in rows), and how long it is. */
    const holdsIn = (chart: Measured) => {
      const found: { double: boolean; row: number; rows: number }[] = [];
      let position = 0;
      for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
        if (token.startsWith('.')) {
          position += token.length > 1 ? Number(token.slice(1)) : 1;
          continue;
        }
        const rows = token.includes('~') ? Number(token.split('~')[1]) : 1;
        if (rows > 1) found.push({ double: token.startsWith('xx'), row: position, rows });
        position += rows;
      }
      return found;
    };

    for (const density of DENSITIES) {
      it(`turn some of the holds of ${density} into two, and never all of them`, () => {
        const holds = holdsIn(analyze(songs.b.samples!, { density }));
        const doubled = holds.filter((hold) => hold.double);
        expect(holds.length).toBeGreaterThanOrEqual(2);
        expect(doubled.length).toBeGreaterThanOrEqual(1);
        expect(doubled.length).toBeLessThan(holds.length);
        for (const hold of doubled) expect(hold.rows).toBeGreaterThanOrEqual(2);
      }, SLOW);
    }

    it('are kept well apart', () => {
      for (const density of DENSITIES) {
        const doubled = holdsIn(analyze(songs.b.samples!, { density })).filter((hold) => hold.double);
        for (let i = 1; i < doubled.length; i++) expect(doubled[i].row - doubled[i - 1].row).toBeGreaterThanOrEqual(16);
      }
    }, SLOW);

    it('never have a double on the row before or after them', () => {
      for (const density of DENSITIES) {
        const chart = analyze(songs.b.samples!, { density });
        const tokens = chart.chart.split(/\s+/).filter(Boolean);
        for (let i = 1; i < tokens.length; i++) {
          const pair = [tokens[i - 1], tokens[i]];
          if (pair.some((token) => token.startsWith('xx~'))) {
            expect(pair.filter((token) => token === 'xx' || token.startsWith('xx~')).length).toBeLessThan(2);
          }
        }
      }
    }, SLOW);
  });

  it('never asks for more taps a second than a hand can give, even on Hard', () => {
    for (const key of ['a', 'c']) {
      const chart = analyze(songs[key].samples!, { density: 'hard' });
      const row = 1 / rowsPerSecond(chart);
      let position = 0;
      let last: number | undefined;
      let quickest = Infinity;
      for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
        if (token.startsWith('.')) {
          position += token.length > 1 ? Number(token.slice(1)) : 1;
          continue;
        }
        if (last !== undefined) quickest = Math.min(quickest, (position - last) * row);
        last = position;
        position += token.includes('~') ? Number(token.split('~')[1]) : 1;
      }
      expect(quickest).toBeGreaterThanOrEqual(1 / 4.5 - 1e-6);
    }
  }, SLOW);

  it('reads the level a chart was saved with, including the old name for Easy', () => {
    expect(DENSITIES.map(densityFrom)).toEqual(DENSITIES);
    expect(densityFrom('normal')).toBe('easy'); // (charts saved before the levels moved up one)
    expect(densityFrom('insane')).toBe(DEFAULT_DENSITY);
    expect(densityFrom(undefined)).toBe(DEFAULT_DENSITY);
  });

  it('puts the tiles on the drums, not between them', () => {
    const chart = analyze(songs.a.samples!, MEDIUM);
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
      position += token.includes('~') ? Number(token.split('~')[1]) : 1;
    }
    expect(onBeat / total).toBeGreaterThan(0.7);
  }, SLOW);

  for (const key of ['a', 'b', 'c', 'd']) {
    const song = songs[key];
    it(`starts row 0 on a beat of the ${song.bpm} BPM song, so a count-in ticks with the music`, () => {
      const chart = analyze(song.samples!, MEDIUM);
      expect(chart.bpm).toBeCloseTo(song.bpm, 0);
      const beat = 60 / song.bpm;
      const diff = (((chart.offset - song.offset) % beat) + beat) % beat;
      expect(Math.min(diff, beat - diff) * 1000).toBeLessThan(8);
    }, SLOW);
  }

  describe('a song longer than a lap', () => {
    const seconds = 150;
    const bpm = 120;
    const offset = 0.37;
    let samples: Float32Array;
    beforeAll(async () => {
      samples = await synthForAnalysis({ bpm, offset, seconds, seed: 11 });
    }, SLOW);

    /** Rows the chart writes: each token is a row, except a hold, which takes its own length. */
    const rowsWritten = (chart: Measured) =>
      chart.chart
        .split(/\s+/)
        .filter(Boolean)
        .reduce((sum, token) => sum + (token.includes('~') ? Number(token.split('~')[1]) : 1), 0);

    for (const length of LENGTHS) {
      const { min, max } = LENGTH_SECONDS[length];
      it(`is stopped between ${min} and ${max} seconds on ${length}, on a bar line`, () => {
        const chart = analyze(samples, { ...MEDIUM, length });
        const end = chart.end!;
        expect(end).toBeGreaterThanOrEqual(min);
        expect(end).toBeLessThanOrEqual(max);
        expect(chart.duration).toBeCloseTo(seconds, 1); // (the audio is kept whole, only the lap is cut)
        expect(chart.analysis!.length).toBe(length);

        // A whole number of bars from the first beat...
        const row = 60 / (chart.bpm * chart.rowsPerBeat);
        const rows = (end - chart.offset) / row;
        expect(Math.abs(rows - Math.round(rows))).toBeLessThan(0.02);
        expect(Math.round(rows) % (4 * chart.rowsPerBeat)).toBe(0);
        // ...on a real bar line of the song (its beats fall every half second from 0.37 s, its bars every two).
        const bars = (end - offset) / (4 * (60 / bpm));
        expect(Math.min(bars - Math.floor(bars), Math.ceil(bars) - bars) * 4 * (60 / bpm) * 1000).toBeLessThan(10);

        // The tiles cover the lap and stop with it (a hold at the very end may run a few rows over).
        expect(chart.analysis!.rows).toBe(Math.round(rows));
        expect(rowsWritten(chart)).toBeGreaterThanOrEqual(chart.analysis!.rows);
        expect(rowsWritten(chart)).toBeLessThanOrEqual(chart.analysis!.rows + 3);
      }, SLOW);
    }

    it('plays a song that is short enough whole, and says so by leaving the stop out', () => {
      const chart = analyze(songs.b.samples!, { ...MEDIUM, length: 'long' }); // 75 s, under the 90 s of Long
      expect(chart.end).toBeUndefined();
      expect('end' in chart).toBe(true); // (present, so charting a song again clears an older stop)
      const row = 60 / (chart.bpm * chart.rowsPerBeat);
      expect(chart.analysis!.rows).toBe(Math.ceil((chart.duration - chart.offset) / row - 1e-9));
    }, SLOW);

    it('stops a 75 second song asked to be a Short one', () => {
      const chart = analyze(songs.b.samples!, { ...MEDIUM, length: 'short' });
      expect(chart.end!).toBeGreaterThanOrEqual(60);
      expect(chart.end!).toBeLessThanOrEqual(70);
    }, SLOW);

    it('is Medium unless asked for another, and only listens to what is played', () => {
      const chart = analyze(samples, { density: 'medium' });
      expect(chart.analysis!.length).toBe('medium');
      expect(chart.end!).toBeGreaterThanOrEqual(70);
      expect(chart.end!).toBeLessThanOrEqual(80);
    }, SLOW);
  });

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
        position += token.includes('~') ? Number(token.split('~')[1]) : 1;
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
      const rows = analyze(samples, MEDIUM).analysis!.rows;
      tiles.forEach((count, i) => expect(count).toBeGreaterThan(0.95 * Math.trunc(DENSITY[DENSITIES[i]].fraction * rows)));
      expect(tiles[0]).toBeLessThan(tiles[1]);
      expect(tiles[1]).toBeLessThan(tiles[2]);
    }, SLOW);

    it('leaves a silent stretch bare rather than filling it with noise', async () => {
      const gap = (time: number) => time >= 40 && time < 56;
      const song = await synthForAnalysis({ bpm: 120, offset: 0.2, seconds: 96, seed: 5, verse, silent: gap });
      const chart = analyze(song, MEDIUM);
      const rate = rowsPerSecond(chart);
      let inGap = 0;
      let position = 0;
      for (const token of chart.chart.split(/\s+/).filter(Boolean)) {
        const time = chart.offset + position / rate;
        if (token !== '.' && time >= 41 && time < 55) inGap++; // (a kick's tail runs a little past the gap's edges)
        position += token.includes('~') ? Number(token.split('~')[1]) : 1;
      }
      expect(inGap).toBe(0);
    }, SLOW);
  });

  it('is deterministic, and writes a chart the game can read', () => {
    const first = analyze(songs.c.samples!, MEDIUM);
    const second = analyze(songs.c.samples!, MEDIUM);
    expect(second).toEqual(first);
    expect(first.difficulty).toBeGreaterThanOrEqual(1);
    expect(first.difficulty).toBeLessThanOrEqual(5);
    expect(first.chart.split(/\s+/).every((token) => /^(x|xx|xx?~[2-4]|\.)$/.test(token))).toBe(true);
  }, SLOW);

  it('reports how far along it is, ending at 1', () => {
    const seen: number[] = [];
    analyze(songs.d.samples!, MEDIUM, (progress) => {
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
    expect(() => analyze(new Float32Array(SAMPLE_RATE * 20), MEDIUM)).toThrow(AnalysisError);
  });

  it('refuses audio that is too short', () => {
    expect(() => analyze(new Float32Array(SAMPLE_RATE * 2), MEDIUM)).toThrow(/too short/);
  });

  it('refuses a song that is too long', () => {
    expect(() => analyze(new Float32Array(SAMPLE_RATE * (MAX_SECONDS + 1)), MEDIUM)).toThrow(/minutes long/);
  });
});

describe('finding which row is a beat', () => {
  /** A recording with a hit on every row for which `hits(row)` is true (a click each, all as strong). */
  function hitsOn(grid: Grid, rows: number, hits: (row: number) => boolean): Features {
    const frames = Math.ceil((rows / grid.rate + 1) * FPS);
    const env = new Float64Array(frames);
    for (let k = 0; k < rows; k++) {
      if (hits(k)) env[Math.round((grid.phase + k / grid.rate - ENV_LAG) * FPS)] = 1;
    }
    return { env, low: env, mid: env, high: env, rms: new Float64Array(frames), duration: frames / FPS };
  }
  const grid: Grid = { rate: 4, phase: 0.2, score: 1, contrast: 1 };

  it('says how many rows the first beat is after row 0', () => {
    for (const first of [0, 1]) {
      const features = hitsOn(grid, 80, (row) => row % 2 === first);
      expect(beatOffset(features, grid, 2)).toBe(first);
    }
    for (const first of [0, 1, 2, 3]) {
      const features = hitsOn({ ...grid, rate: 4 }, 80, (row) => row % 4 === first);
      expect(beatOffset(features, grid, 4)).toBe(first);
    }
  });

  it('goes for the strongest hits, not the most', () => {
    const features = hitsOn(grid, 80, (row) => row % 2 === 0);
    // Weak clicks on every row in between, as hats are: the kicks still say where the beat is.
    for (let k = 1; k < 80; k += 2) features.env[Math.round((grid.phase + k / grid.rate - ENV_LAG) * FPS)] = 0.3;
    expect(beatOffset(features, grid, 2)).toBe(0);
  });

  it('has nothing to decide when a beat is one row', () => {
    expect(beatOffset(hitsOn(grid, 80, (row) => row % 3 === 2), grid, 1)).toBe(0);
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
