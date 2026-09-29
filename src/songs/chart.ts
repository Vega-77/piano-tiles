import { MAX_HOLD_ROWS, MIN_HOLD_ROWS, TILE_HEIGHT } from '../config';
import type { BeatSpec, Difficulty, Song } from '../types';
import { lengthFrom } from './analysis/length';
import { densityFrom } from './analysis/tiles';
import { beatRows } from './notation';

/**
 * A chart is what the analyser writes for an imported song (`public/songs/<id>/chart.json`): a
 * beat grid found in the recording, and where to put tiles on it. The audio sits next to it.
 */
export interface ChartFile {
  version: 1;
  id: string;
  title: string;
  artist: string;
  /** Audio file name, next to chart.json. */
  audio: string;
  /** Tempo of the beat grid, and how many rows (smallest steps) make up one beat. */
  bpm: number;
  rowsPerBeat: number;
  /** Seconds into the audio at which row 0 of the chart falls: the first beat, so under a beat. */
  offset: number;
  /**
   * A correction, in seconds, added to `offset` when the song is played: positive if the tiles land
   * early against the music. It is set by hand from the tuning panel, for a song the analyser got
   * slightly wrong or a setup with more audio delay than usual.
   */
  nudge?: number;
  /** Length of the audio in seconds. */
  duration: number;
  /**
   * Where in the audio a lap stops, in seconds, for a song longer than a lap may be: on a bar line,
   * so a lap is a whole number of bars. Missing means the whole audio is played.
   */
  end?: number;
  /**
   * When the song was last changed, in milliseconds since 1970. When songs are synced between
   * devices the copy with the later time wins. Missing on a song saved before syncing existed.
   */
  savedAt?: number;
  difficulty: Difficulty;
  hue: number;
  hue2: number;
  /** The tiles, in the notation below. */
  chart: string;
  /** How the analyser got on, for the tuning panel. Never used for playing. */
  analysis?: ChartAnalysis;
}

export interface ChartAnalysis {
  /** 0–1: how well the beats fit the grid. Low means the tiles may not line up with the music. */
  confidence: number;
  /** Seconds the grid and the detected beats drift apart across the song. */
  drift: number;
  /** Whether the tempo was given by hand rather than detected. */
  manualBpm: boolean;
  /** Tiles per second at the busiest moment of the first lap. */
  peakRate: number;
  /** How many tiles, and how many rows, the chart has. */
  tiles: number;
  rows: number;
  /** Tiles per row of the song, roughly the setting the user picked. */
  density: number;
  /** The setting the user picked: easy, medium or hard (older charts say "normal" for easy). */
  level?: string;
  /** How long a lap was allowed to be: short, medium or long (older charts have none, and play whole). */
  length?: string;
  /** What the analyser thought was wrong, if anything, in words. */
  warnings?: string[];
}

/** The furthest (seconds) the tuning panel may shift a song's audio against its tiles. */
export const MAX_NUDGE = 0.5;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUDIO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Recorded charts carry no pitch: the recording supplies the sound, so the tiles' notes are unused.
const NO_PITCH = 0;

const TAP = /^x$/;
const DOUBLE = /^xx$/;
const HOLD = /^x~(\d)?$/;
const REST = /^\.(\d+)?$/;

function parseToken(token: string): BeatSpec {
  const rest = REST.exec(token);
  if (rest) return { type: 'rest', rows: rest[1] ? Number(rest[1]) : 1 };
  if (TAP.test(token)) return { type: 'tap', freq: NO_PITCH };
  if (DOUBLE.test(token)) return { type: 'double', freqs: [NO_PITCH, NO_PITCH] };
  const hold = HOLD.exec(token);
  if (hold) {
    const rows = hold[1] ? Number(hold[1]) : MIN_HOLD_ROWS;
    if (rows < MIN_HOLD_ROWS || rows > MAX_HOLD_ROWS) {
      throw new Error(`Hold "${token}" must be ${MIN_HOLD_ROWS}–${MAX_HOLD_ROWS} rows long`);
    }
    return { type: 'hold', freq: NO_PITCH, rows };
  }
  throw new Error(`Invalid chart token "${token}"`);
}

/**
 * Parses a chart, written as whitespace-separated tokens (line breaks are only for reading):
 *   x       a tap tile (one row)
 *   xx      a double: two tiles at once, one lane apart
 *   x~      a hold tile, 2 rows tall
 *   x~3     a hold tile, 3 rows tall (2–4 allowed)
 *   .       a rest: one row with nothing to tap
 *   .12     a rest twelve rows long
 * Neighbouring rests are merged.
 */
export function parseChart(source: string): BeatSpec[] {
  const beats: BeatSpec[] = [];
  for (const token of source.split(/\s+/).filter(Boolean)) {
    const beat = parseToken(token);
    const last = beats[beats.length - 1];
    if (beat.type === 'rest' && last?.type === 'rest') last.rows += beat.rows;
    else beats.push(beat);
  }
  return beats;
}

/** The chart's tiles as text, the inverse of `parseChart` (rests are written one row at a time, `bar` rows to a line). */
export function formatChart(beats: readonly BeatSpec[], bar = 8): string {
  const lines: string[] = [];
  let line: string[] = [];
  let rows = 0;
  const flush = () => {
    if (line.length > 0) lines.push(line.join(' '));
    line = [];
  };
  for (const beat of beats) {
    const token =
      beat.type === 'tap' ? 'x'
      : beat.type === 'double' ? 'xx'
      : beat.type === 'hold' ? `x~${beat.rows}`
      : '.';
    const size = beatRows(beat);
    for (let i = 0; i < (beat.type === 'rest' ? beat.rows : 1); i++) line.push(token);
    rows += size;
    if (rows >= bar) {
      flush();
      rows = 0;
    }
  }
  flush();
  return lines.join('\n');
}

/** Seconds one row lasts on the first lap. */
export function rowSeconds(chart: Pick<ChartFile, 'bpm' | 'rowsPerBeat'>): number {
  return 60 / (chart.bpm * chart.rowsPerBeat);
}

/**
 * How many rows one lap has: enough to cover the audio that is played (all of it, or up to `end`)
 * after the first beat. A hundredth of a row is forgiven, because the numbers in a chart are rounded
 * and a lap that ends on a bar line must not gain a row from that.
 */
export function chartRows(chart: Pick<ChartFile, 'bpm' | 'rowsPerBeat' | 'offset' | 'duration' | 'end'>): number {
  return Math.max(1, Math.ceil(((chart.end ?? chart.duration) - chart.offset) / rowSeconds(chart) - 0.01));
}

function fail(message: string): never {
  throw new Error(`Bad chart: ${message}`);
}

function textField(value: unknown, name: string, max = 120): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`"${name}" is missing`);
  return value.trim().slice(0, max);
}

function numberField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`"${name}" must be a number from ${min} to ${max}`);
  }
  return value;
}

/** Checks a parsed chart.json and returns it typed, or throws an Error that says what's wrong. */
export function validateChart(raw: unknown): ChartFile {
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) fail(`unsupported version ${String(c.version)}`);

  const id = textField(c.id, 'id');
  if (!ID.test(id)) fail(`"id" must be lowercase letters, digits and dashes (got "${id}")`);
  const audio = textField(c.audio, 'audio');
  if (!AUDIO.test(audio)) fail(`"audio" must be a plain file name (got "${audio}")`);
  const rowsPerBeat = numberField(c.rowsPerBeat, 'rowsPerBeat', 1, 4);
  if (![1, 2, 4].includes(rowsPerBeat)) fail('"rowsPerBeat" must be 1, 2 or 4');
  const difficulty = numberField(c.difficulty, 'difficulty', 1, 5);
  if (!Number.isInteger(difficulty)) fail('"difficulty" must be a whole number');

  const chart: ChartFile = {
    version: 1,
    id,
    title: textField(c.title, 'title'),
    artist: typeof c.artist === 'string' && c.artist.trim() ? c.artist.trim().slice(0, 120) : 'Imported',
    audio,
    bpm: numberField(c.bpm, 'bpm', 40, 300),
    rowsPerBeat,
    offset: numberField(c.offset, 'offset', 0, 30),
    duration: numberField(c.duration, 'duration', 5, 3600),
    difficulty: difficulty as Difficulty,
    hue: numberField(c.hue, 'hue', 0, 360),
    hue2: numberField(c.hue2, 'hue2', 0, 360),
    chart: typeof c.chart === 'string' ? c.chart : fail('"chart" is missing'),
  };
  if (c.nudge !== undefined) chart.nudge = numberField(c.nudge, 'nudge', -MAX_NUDGE, MAX_NUDGE);
  if (c.end !== undefined) {
    chart.end = numberField(c.end, 'end', 5, 3600);
    if (chart.end > chart.duration + 0.05) fail('"end" is past the end of the audio');
    if (chart.end <= chart.offset) fail('"end" must be after "offset"');
  }
  if (c.savedAt !== undefined) chart.savedAt = numberField(c.savedAt, 'savedAt', 0, Number.MAX_SAFE_INTEGER);
  if (typeof c.analysis === 'object' && c.analysis !== null) chart.analysis = c.analysis as ChartAnalysis;
  return chart;
}

/** The chart's offset with the hand-set correction applied: where row 0 really falls in the audio. */
export function playOffset(chart: Pick<ChartFile, 'offset' | 'nudge'>): number {
  return chart.offset + (chart.nudge ?? 0);
}

/**
 * Turns a chart into a playable song. The lap is exactly as many rows as the audio needs (short
 * charts are padded with rests), so the recording and the tiles start each lap together and the
 * recording's last beat is the lap's last row.
 */
export function songFromChart(chart: ChartFile, folderUrl: string): Song {
  const beats = parseChart(chart.chart);
  const offset = playOffset(chart);
  const rows = beats.reduce((sum, beat) => sum + beatRows(beat), 0);
  // (A chart may run a row over: the analyser rounds its last row up.)
  const room = chartRows(chart);
  if (rows > room + 1) {
    fail(`"${chart.title}" has ${rows} rows but its audio only has room for ${room}`);
  }
  // The lap covers all the audio; if the nudge moves the audio's end later, the tiles are padded to match.
  const lap = Math.max(rows, chartRows({ ...chart, offset }));
  if (rows < lap) {
    const last = beats[beats.length - 1];
    if (last?.type === 'rest') last.rows += lap - rows;
    else beats.push({ type: 'rest', rows: lap - rows });
  }
  if (!beats.some((beat) => beat.type !== 'rest')) fail(`"${chart.title}" has no tiles`);

  const base = folderUrl.endsWith('/') ? folderUrl : `${folderUrl}/`;
  return {
    id: chart.id,
    title: chart.title,
    composer: chart.artist,
    description: [
      `${Math.round(chart.bpm)} BPM, charted from a recording.`,
      // A shaky chart is worth saying so on the card, before someone blames the game.
      chart.analysis?.warnings?.[0],
    ].filter(Boolean).join(' '),
    difficulty: chart.difficulty,
    bpm: chart.bpm,
    rowsPerBeat: chart.rowsPerBeat,
    rowsPerBar: chart.rowsPerBeat * 4,
    speed: ((chart.bpm * chart.rowsPerBeat) / 60) * TILE_HEIGHT,
    hue: chart.hue,
    hue2: chart.hue2,
    beats,
    track: [],
    recording: { url: `${base}${chart.audio}`, offset, duration: chart.duration, ...(chart.end !== undefined && { end: chart.end }) },
    imported: {
      nudge: chart.nudge ?? 0,
      manualBpm: chart.analysis?.manualBpm ?? false,
      level: densityFrom(chart.analysis?.level),
      length: lengthFrom(chart.analysis?.length),
      confidence: chart.analysis?.confidence,
      warnings: chart.analysis?.warnings ?? [],
    },
  };
}
