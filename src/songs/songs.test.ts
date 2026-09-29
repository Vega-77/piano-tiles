import { afterEach, describe, expect, it, vi } from 'vitest';
import { TILE_HEIGHT } from '../config';
import { songFromChart } from './chart';
import { DIFFICULTY_LABELS, songBars, songFeatures, songRows, songSeconds } from './songs';
import { fakeChart } from './testing';

/** The switch for double holds lives in the config: this lets a test turn it on and off. */
const flags = vi.hoisted(() => ({ doubleHolds: false }));
vi.mock('../config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config')>();
  return { ...original, get DOUBLE_HOLDS() { return flags.doubleHolds; } };
});

afterEach(() => {
  flags.doubleHolds = false;
});

const folder = 'https://example.test/songs/demo/';

describe('what the screens say about a song', () => {
  // 120 BPM on a two-rows-a-beat grid: 4 rows a second. 16 rows is 8 beats, 2 bars.
  const song = songFromChart(fakeChart('demo', { chart: 'x . x . xx . x~3 . .', duration: 4 }), folder);

  it('counts the rows of a lap, gaps included, and the bars they make', () => {
    expect(songRows(song)).toBe(16);
    expect(songBars(song)).toBe(2);
  });

  it('says how long a lap takes at the first lap’s speed', () => {
    expect(song.speed).toBeCloseTo(((120 * 2) / 60) * TILE_HEIGHT, 9);
    expect(songSeconds(song)).toBeCloseTo(4, 9);
  });

  it('says whether it has doubles and holds', () => {
    expect(songFeatures(song)).toEqual({ doubles: true, holds: true });
    expect(songFeatures(songFromChart(fakeChart('plain', { chart: 'x . x .', duration: 2 }), folder))).toEqual({
      doubles: false,
      holds: false,
    });
  });

  it('counts a double hold as both a double and a hold', () => {
    flags.doubleHolds = true;
    const chart = fakeChart('twin', { chart: 'x . xx~3 . .', duration: 4 });
    expect(songFeatures(songFromChart(chart, folder))).toEqual({ doubles: true, holds: true });
  });

  it('counts one that is switched off as the plain hold it is played as', () => {
    const chart = fakeChart('twin', { chart: 'x . xx~3 . .', duration: 4 });
    expect(songFeatures(songFromChart(chart, folder))).toEqual({ doubles: false, holds: true });
  });

  it('names every difficulty from 1 to 5', () => {
    expect(Object.keys(DIFFICULTY_LABELS)).toEqual(['1', '2', '3', '4', '5']);
    expect(DIFFICULTY_LABELS[3]).toBe('Medium');
  });
});
