import { describe, expect, it } from 'vitest';
import { TILE_HEIGHT } from '../config';
import type { Song } from '../types';
import { chartRows, formatChart, parseChart, playOffset, publicationOf, rowSeconds, songFromChart, validateChart, type ChartFile } from './chart';
import { beatRows } from './notation';

const rowsOf = (source: string) => parseChart(source).reduce((sum, beat) => sum + beatRows(beat), 0);

/** A chart for a 30-second recording at 120 BPM with two rows per beat: a row is 0.25s. */
function chartFile(overrides: Partial<ChartFile> = {}): ChartFile {
  return {
    version: 1,
    id: 'demo',
    title: 'Demo',
    artist: 'Somebody',
    audio: 'audio-1a2b3c4d.mp3',
    bpm: 120,
    rowsPerBeat: 2,
    offset: 0.1,
    duration: 30,
    difficulty: 2,
    hue: 200,
    hue2: 260,
    chart: 'x . x . xx . x~3 . . . . .',
    ...overrides,
  };
}

describe('chart notation', () => {
  it('reads taps, doubles, holds and rests, each with the rows it takes', () => {
    expect(parseChart('x xx x~ x~4 . .3')).toEqual([
      { type: 'tap', freq: 0 },
      { type: 'double', freqs: [0, 0] },
      { type: 'hold', freq: 0, rows: 2 },
      { type: 'hold', freq: 0, rows: 4 },
      { type: 'rest', rows: 4 },
    ]);
  });

  it('reads double holds, with the rows they take', () => {
    expect(parseChart('xx~ xx~4 x~3')).toEqual([
      { type: 'doublehold', freqs: [0, 0], rows: 2 },
      { type: 'doublehold', freqs: [0, 0], rows: 4 },
      { type: 'hold', freq: 0, rows: 3 },
    ]);
  });

  it('merges neighbouring rests and reads long ones', () => {
    expect(parseChart('x . . .12 . x')).toEqual([
      { type: 'tap', freq: 0 },
      { type: 'rest', rows: 15 },
      { type: 'tap', freq: 0 },
    ]);
  });

  it('ignores line breaks', () => {
    expect(parseChart('x .\n x\n\n.')).toHaveLength(4);
  });

  it.each(['y', 'x~1', 'x~5', 'xx~1', 'xx~5', 'x+x', 'xxx', 'xxx~3', 'C4', '.x'])('refuses "%s"', (token) => {
    expect(() => parseChart(`x ${token}`)).toThrow();
  });

  it('writes a chart back out the way it was read', () => {
    const source = 'x . x . xx . x~3 . x . x . . . xx~4 . x . x . x .';
    const beats = parseChart(source);
    expect(parseChart(formatChart(beats))).toEqual(beats);
    expect(formatChart(beats).split('\n').length).toBeGreaterThan(1); // broken into lines to read
  });
});

describe('chart timing', () => {
  it('works out the length of a row and of a lap from the audio', () => {
    const chart = chartFile();
    expect(rowSeconds(chart)).toBeCloseTo(0.25, 12);
    // (30 - 0.1) / 0.25 = 119.6 rows, rounded up so the last of the audio is covered.
    expect(chartRows(chart)).toBe(120);
  });

  it('does not add a row for floating point noise', () => {
    expect(chartRows(chartFile({ offset: 0, duration: 30 }))).toBe(120);
  });
});

describe('chart validation', () => {
  it('accepts a good chart', () => {
    expect(validateChart(chartFile())).toEqual(chartFile());
  });

  it('keeps the analysis details when there are some', () => {
    const analysis = { confidence: 0.9, drift: 0.01, manualBpm: false, peakRate: 3.2, tiles: 100, rows: 120, density: 0.8 };
    expect(validateChart({ ...chartFile(), analysis }).analysis).toEqual(analysis);
  });

  it.each([
    ['a missing id', { id: undefined }],
    ['an id with capitals', { id: 'My-Song' }],
    ['an id with a slash', { id: '../etc' }],
    ['an audio path that leaves the folder', { audio: '../../secret.mp3' }],
    ['an audio path with a folder in it', { audio: 'a/b.mp3' }],
    ['an unknown version', { version: 2 }],
    ['a tempo that is out of range', { bpm: 900 }],
    ['a tempo that is not a number', { bpm: '120' }],
    ['three rows per beat', { rowsPerBeat: 3 }],
    ['a negative offset', { offset: -1 }],
    ['a fractional difficulty', { difficulty: 2.5 }],
    ['no chart', { chart: undefined }],
    ['no title', { title: '  ' }],
  ])('refuses %s', (_name, patch) => {
    expect(() => validateChart({ ...chartFile(), ...patch })).toThrow(/Bad chart/);
  });

  it('refuses something that is not an object', () => {
    expect(() => validateChart(null)).toThrow(/Bad chart/);
    expect(() => validateChart('chart')).toThrow(/Bad chart/);
  });
});

describe('making a song from a chart', () => {
  const folder = 'https://example.test/songs/demo/';

  it('sets up the recording and the speed from the tempo', () => {
    const song = songFromChart(chartFile(), folder);
    expect(song.recording).toEqual({ url: `${folder}audio-1a2b3c4d.mp3`, offset: 0.1, duration: 30 });
    expect(song.track).toEqual([]);
    expect(song.composer).toBe('Somebody');
    expect(song.rowsPerBar).toBe(8);
    expect(song.speed).toBeCloseTo(((120 * 2) / 60) * TILE_HEIGHT, 9);
  });

  it('adds the missing slash to a folder url', () => {
    expect(songFromChart(chartFile(), 'songs/demo').recording?.url).toBe('songs/demo/audio-1a2b3c4d.mp3');
  });

  it('pads a short chart with rests so the lap covers all the audio', () => {
    const song = songFromChart(chartFile(), folder);
    expect(song.beats.reduce((sum, beat) => sum + beatRows(beat), 0)).toBe(chartRows(chartFile()));
    expect(song.beats[song.beats.length - 1].type).toBe('rest');
  });

  it('allows a chart one row longer than the audio, but no more', () => {
    const wanted = chartRows(chartFile());
    expect(() => songFromChart(chartFile({ chart: `x .${wanted}` }), folder)).not.toThrow(); // wanted + 1 rows
    expect(() => songFromChart(chartFile({ chart: `x .${wanted + 1}` }), folder)).toThrow(/room for/);
    expect(rowsOf(`x .${wanted}`)).toBe(wanted + 1);
  });

  it('refuses a chart with no tiles', () => {
    expect(() => songFromChart(chartFile({ chart: '. . . .' }), folder)).toThrow(/no tiles/);
  });

  it('mentions on the card when the analyser was unsure', () => {
    const analysis = { confidence: 0.1, drift: 0, manualBpm: false, peakRate: 2, tiles: 5, rows: 100, density: 0.1, warnings: ['The beat is weak.'] };
    expect(songFromChart(chartFile({ analysis }), folder).description).toBe('120 BPM, charted from a recording. The beat is weak.');
    expect(songFromChart(chartFile(), folder).description).toBe('120 BPM, charted from a recording.');
  });

  it('keeps what the tuning panel needs to start from', () => {
    expect(songFromChart(chartFile(), folder).imported).toEqual({
      nudge: 0,
      manualBpm: false,
      level: 'medium',
      length: 'medium',
      confidence: undefined,
      publication: 'draft',
      warnings: [],
    });

    const analysis = {
      confidence: 0.8,
      drift: 0.01,
      manualBpm: true,
      peakRate: 3,
      tiles: 5,
      rows: 100,
      density: 0.3,
      level: 'hard',
      length: 'long',
      warnings: ['Very fast.'],
    };
    expect(songFromChart(chartFile({ analysis, nudge: -0.03 }), folder).imported).toEqual({
      nudge: -0.03,
      manualBpm: true,
      level: 'hard',
      length: 'long',
      confidence: 0.8,
      publication: 'draft',
      warnings: ['Very fast.'],
    });

    // A level the app doesn't know is shown as the middle one rather than trusted.
    expect(songFromChart(chartFile({ analysis: { ...analysis, level: 'insane' } }), folder).imported?.level).toBe('medium');
    // Charts saved before the levels moved up a step called what is now Easy "normal".
    expect(songFromChart(chartFile({ analysis: { ...analysis, level: 'normal' } }), folder).imported?.level).toBe('easy');
    // The same goes for a length the app doesn't know, and for charts saved before there were lengths.
    expect(songFromChart(chartFile({ analysis: { ...analysis, length: 'endless' } }), folder).imported?.length).toBe('medium');
  });
});

describe('a song cut short', () => {
  const folder = 'https://example.test/songs/demo/';
  const rowsOf = (song: Song) => song.beats.reduce((sum, beat) => sum + beatRows(beat), 0);

  it('counts only the rows before the cut', () => {
    // 30 s of audio, but the lap stops at 20 s: (20 - 0.1) / 0.25 = 79.6 rows, rounded up.
    expect(chartRows(chartFile({ end: 20 }))).toBe(80);
    expect(chartRows(chartFile())).toBe(120);
  });

  it('does not add a row when the cut is on the last row line, give or take rounding', () => {
    // 0.1 + 80 rows of 0.25 s = 20.1 s, written down as 20.1 or as 20.099.
    expect(chartRows(chartFile({ end: 20.1 }))).toBe(80);
    expect(chartRows(chartFile({ end: 20.099 }))).toBe(80);
  });

  it('is kept when it is sound, and left out when there is none', () => {
    expect(validateChart(chartFile({ end: 20 })).end).toBe(20);
    expect('end' in validateChart(chartFile())).toBe(false);
  });

  it.each([
    ['past the end of the audio', { end: 31 }],
    ['before the first row', { end: 5, offset: 6 }],
    ['not a number', { end: 'soon' }],
    ['too short to play', { end: 2 }],
  ])('refuses a cut that is %s', (_name, patch) => {
    expect(() => validateChart({ ...chartFile(), ...patch })).toThrow(/end/);
  });

  it('lets the audio finish where the cut is, and pads the tiles up to it', () => {
    const song = songFromChart(chartFile({ end: 20 }), folder);
    expect(song.recording).toEqual({ url: `${folder}audio-1a2b3c4d.mp3`, offset: 0.1, duration: 30, end: 20 });
    expect(rowsOf(song)).toBe(80);
    expect(song.beats[song.beats.length - 1].type).toBe('rest');
  });

  it('plays a song without a cut in full, and gives its recording no end', () => {
    const song = songFromChart(chartFile(), folder);
    expect('end' in song.recording!).toBe(false);
  });

  it('refuses tiles that run on past the cut', () => {
    expect(() => songFromChart(chartFile({ end: 20, chart: 'x .80' }), folder)).not.toThrow(); // 81 rows: one over is allowed
    expect(() => songFromChart(chartFile({ end: 20, chart: 'x .81' }), folder)).toThrow(/room for 80/);
  });
});

describe('the sync nudge', () => {
  const folder = 'https://example.test/songs/demo/';
  const rowsOf = (song: Song) => song.beats.reduce((sum, beat) => sum + beatRows(beat), 0);

  it('moves the recording against the tiles by adding to the offset', () => {
    expect(playOffset(chartFile({ offset: 0.1 }))).toBe(0.1);
    expect(playOffset(chartFile({ offset: 0.1, nudge: 0.03 }))).toBeCloseTo(0.13, 12);
    expect(songFromChart(chartFile({ offset: 0.1, nudge: -0.02 }), folder).recording?.offset).toBeCloseTo(0.08, 12);
  });

  it('lets the audio start late, for a negative total', () => {
    expect(songFromChart(chartFile({ offset: 0.01, nudge: -0.05 }), folder).recording?.offset).toBeCloseTo(-0.04, 12);
  });

  it('pads the lap when the audio now ends later, and never loses tiles when it ends earlier', () => {
    const full = 'x .119'; // 120 rows: all of the audio, as the analyser writes it
    expect(rowsOf(songFromChart(chartFile({ chart: full }), folder))).toBe(120);
    // The audio starting earlier in the lap (a negative nudge) needs more rows to cover it: 0.5s is two rows here.
    expect(rowsOf(songFromChart(chartFile({ chart: full, nudge: -0.5 }), folder))).toBe(122);
    // A later start has fewer rows of audio, but the chart's own rows stay.
    expect(rowsOf(songFromChart(chartFile({ chart: full, nudge: 0.5 }), folder))).toBe(120);
  });

  it('is checked', () => {
    expect(validateChart(chartFile({ nudge: 0.25 })).nudge).toBe(0.25);
    expect(() => validateChart(chartFile({ nudge: 0.75 }))).toThrow(/nudge/);
    expect(() => validateChart({ ...chartFile(), nudge: 'lots' })).toThrow(/nudge/);
  });
});

describe('where a song stands with the published songs', () => {
  const folder = 'https://example.test/songs/demo/';

  it('is a draft until published, changed once it is saved after that, and live while it is as published', () => {
    expect(publicationOf({ savedAt: 5 })).toBe('draft');
    expect(publicationOf({})).toBe('draft');
    expect(publicationOf({ savedAt: 5, publishedAt: 5 })).toBe('live');
    expect(publicationOf({ savedAt: 9, publishedAt: 5 })).toBe('changed');
    expect(publicationOf({ savedAt: 4, publishedAt: 5 })).toBe('live');
  });

  it('is shown for the song made from the chart', () => {
    expect(songFromChart(chartFile({ savedAt: 8, publishedAt: 8 }), folder).imported?.publication).toBe('live');
    expect(songFromChart(chartFile({ savedAt: 9, publishedAt: 8 }), folder).imported?.publication).toBe('changed');
  });
});
