import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAR_Y,
  COMBO_MAX_MULTIPLIER,
  COMBO_STEP,
  COUNT_IN_BEATS,
  DOUBLE_HOLD_LATE_WINDOW,
  DOUBLE_LANES,
  GOOD_WINDOW,
  HOLD_TICK_POINTS,
  LAP_REST_SECONDS,
  LAP_SPEED_STEP,
  LIFE_CHAIN,
  LIVES,
  OK_WINDOW,
  PERFECT_WINDOW,
  POINTS,
  STRIKE_GRACE,
  TILE_HEIGHT,
} from '../config';
import { buildTrack, type Arrangement } from '../songs/arrangement';
import { beatRows } from '../songs/notation';
import type { BeatSpec, GameState, MusicEvent, Recording, Song, Tile } from '../types';
import type { Sound } from './audio';
import { noopFx, type Fx } from './effects';
import { comboMultiplier, continueScore, GameEngine, judge, type GameOverResult } from './engine';
import { getBest, loadStats } from './storage';
import { Timeline } from './timeline';
import { listenToTrace } from './trace';

/** How much faster than the first lap the given lap runs: 1, 1.2, 1.4, 1.6... */
const speed = (lap: number) => 1 + LAP_SPEED_STEP * lap;

// ---- a controllable song clock; the fake Sound reads it, and each "frame" runs the real loop ----
let songTime = 0;
let queue: FrameRequestCallback[] = [];

function runFrame(): void {
  const callbacks = queue;
  queue = [];
  for (const callback of callbacks) callback(0);
}

/** Jump the clock to `time` and run one frame there. */
function goTo(time: number): void {
  songTime = time;
  runFrame();
}

function step(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    songTime += 1 / 60;
    runFrame();
  }
}

/** Run the clock on in frames until it reaches `time`, so every frame in between gets to see what is due. */
function runTo(time: number): void {
  while (songTime < time) step();
}

beforeEach(() => {
  songTime = 0;
  queue = [];
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
});

// ---- builders ----
const SPEED = 50; // percent of board height per second on lap 0 => 2 rows per second
const START = 100; // song time when the game starts

const tap = (freq = 440): BeatSpec => ({ type: 'tap', freq });
const double = (): BeatSpec => ({ type: 'double', freqs: [440, 550] });
const hold = (rows: number): BeatSpec => ({ type: 'hold', freq: 330, rows });
const doubleHold = (rows: number): BeatSpec => ({ type: 'doublehold', freqs: [440, 550], rows });
const rest = (rows = 1): BeatSpec => ({ type: 'rest', rows });
/** A realistic-length song. (A one-beat song would have a one-row lap, and laps shrink geometrically.) */
const manyTaps = (count: number): BeatSpec[] => Array.from({ length: count }, () => tap());

function makeSong(beats: BeatSpec[], speed: number, arrangement?: Arrangement, recording?: Recording): Song {
  return {
    id: 'test', title: 'Test', composer: 'Tester', description: '', difficulty: 1,
    bpm: 100, rowsPerBeat: 2, rowsPerBar: arrangement?.rowsPerBar ?? 8, speed, hue: 200, hue2: 250,
    beats, track: recording ? [] : buildTrack(beats, arrangement), recording,
  };
}

interface Scheduled { event: MusicEvent; at: number; secondsPerRow: number }
interface Played { url: string; at: number; rate: number; notBefore?: number; end?: number }

interface SetupOptions {
  speed?: number;
  arrangement?: Arrangement;
  recording?: Recording;
  effects?: Fx;
  /**
   * The board is empty through the count-in, so by default the clock is run on to where the first
   * tile is coming into view, which is where most tests want to start. `false` stays at the very start.
   */
  onBoard?: boolean;
  /**
   * Lives the run starts with. Most tests are about what a mistake does to the board and the run, and are clearest when the
   * first one ends it, so that is the default here (the game itself gives `LIVES`, and the tests on lives ask for them).
   */
  lives?: number;
}

/** Rows before the first tile reaches the bar at which `setup` leaves the clock: three rows above it, in view. */
const IN_VIEW_ROWS = 3;

function setup(
  beats: BeatSpec[],
  { speed = SPEED, arrangement, recording, effects = noopFx, onBoard = true, lives = 1 }: SetupOptions = {},
) {
  const scheduled: Scheduled[] = [];
  const played: Played[] = [];
  const calls = { started: 0, stopped: 0, suspended: 0, resumed: 0, silenced: 0, levelUps: 0, errors: 0 };
  const states: GameState[] = [];
  const results: GameOverResult[] = [];
  const audio: Sound = {
    unlock() {},
    now: () => songTime,
    startSong: () => { calls.started++; },
    stopSong: () => { calls.stopped++; },
    schedule: (event, at, secondsPerRow) => { scheduled.push({ event, at, secondsPerRow }); },
    load: async () => {},
    playRecording: (url, at, rate, options = {}) => { played.push({ url, at, rate, ...options }); },
    silence: () => { calls.silenced++; },
    suspend: () => { calls.suspended++; },
    resume: () => { calls.resumed++; },
    playError: () => { calls.errors++; },
    playLevelUp: () => { calls.levelUps++; },
  };
  const engine = new GameEngine({
    layer: document.createElement('div'),
    audio,
    effects,
    onStateChange: (state) => states.push(state),
    onGameOver: (result) => results.push(result),
    lives,
  });
  songTime = START;
  const song = makeSong(beats, speed, arrangement, recording);
  engine.start(song);
  const rate = speed / TILE_HEIGHT; // rows per second on lap 0
  // The first tile comes after a count-in of COUNT_IN_BEATS beats, like every later lap's.
  const t0 = START + (COUNT_IN_BEATS * song.rowsPerBeat) / rate;
  // The same clock the engine builds, to say when each lap starts and how long its rest is.
  const rows = beats.reduce((sum, beat) => sum + beatRows(beat), 0);
  const timeline = new Timeline(rate, rows, t0, COUNT_IN_BEATS * song.rowsPerBeat);
  if (onBoard) goTo(t0 - IN_VIEW_ROWS / rate);
  return { engine, song, scheduled, played, calls, states, results, rate, t0, timeline };
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

/** Tiles of the lowest beat that still has an uncleared tile. */
function nextBeat(engine: GameEngine): Tile[] {
  const first = engine.getTiles().find((t) => !t.isHit);
  return first ? engine.getTiles().filter((t) => t.beat === first.beat) : [];
}

const firstTile = (engine: GameEngine): Tile => engine.getTiles()[0];
const centre = (tile: Tile): number => tile.yPos + tile.rows * TILE_HEIGHT - TILE_HEIGHT / 2;

/** Move the clock to `offset` seconds after the tile is centred on the bar (negative = early), then tap its lane. */
function tapAt(engine: GameEngine, tile: Tile, offset: number, key = 'p1'): void {
  goTo(tile.time + offset);
  engine.press(tile.lane, key);
}

/** Clear tiles perfectly, holding holds to the end, until `until()` or the game stops. */
function playPerfectly(engine: GameEngine, until: () => boolean, maxBeats = 1000): void {
  for (let i = 0; i < maxBeats && !until() && engine.getState().status === 'playing'; i++) {
    const group = nextBeat(engine);
    if (group.length === 0) {
      step(6); // nothing to tap yet, e.g. through the rest between laps
      continue;
    }
    goTo(group[0].time);
    for (const tile of group) engine.press(tile.lane, `p${tile.id}`);
    for (const tile of group) {
      if (tile.kind !== 'hold') continue;
      goTo(must(tile.hold).end);
      engine.release(`p${tile.id}`);
    }
  }
}

/** Run on through the rest and count-in that follow a lap, until the next lap's first tiles are on the board. */
function throughBreak(engine: GameEngine, maxFrames = 3000): void {
  for (let i = 0; i < maxFrames && nextBeat(engine).length === 0 && engine.getState().status === 'playing'; i++) step();
}

/** Let the clock run in small steps until the game ends (e.g. a tile is missed). */
function stepUntilOver(engine: GameEngine, maxFrames = 600): void {
  for (let i = 0; i < maxFrames && engine.getState().status === 'playing'; i++) step();
}

describe('judge and comboMultiplier', () => {
  it('grades by distance from the bar in either direction, and refuses taps that are too far off', () => {
    expect(judge(0)).toEqual({ judgment: 'perfect', early: false });
    expect(judge(-(PERFECT_WINDOW - 0.001))).toEqual({ judgment: 'perfect', early: true });
    expect(judge(PERFECT_WINDOW + 0.001)).toEqual({ judgment: 'good', early: false });
    expect(judge(-(GOOD_WINDOW - 0.001))).toEqual({ judgment: 'good', early: true });
    expect(judge(GOOD_WINDOW + 0.001)).toEqual({ judgment: 'ok', early: false });
    expect(judge(-(OK_WINDOW - 0.001))).toEqual({ judgment: 'ok', early: true });
    expect(judge(OK_WINDOW + 0.001)).toEqual({ judgment: null, early: false });
    expect(judge(-(OK_WINDOW + 0.001))).toEqual({ judgment: null, early: true });
  });

  it('gives a tile that allows a longer late tap an OK for it, but no more room early', () => {
    expect(judge(0.4, 0.5)).toEqual({ judgment: 'ok', early: false });
    expect(judge(0.501, 0.5)).toEqual({ judgment: null, early: false });
    expect(judge(-0.3, 0.5)).toEqual({ judgment: null, early: true });
    expect(judge(0.4, 0.1)).toEqual({ judgment: null, early: false }); // (never less than the usual window)
    expect(judge(0.2, 0.1)).toEqual({ judgment: 'ok', early: false });
  });

  it('adds a multiplier for every COMBO_STEP perfects, up to a cap', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(COMBO_STEP - 1)).toBe(1);
    expect(comboMultiplier(COMBO_STEP)).toBe(2);
    expect(comboMultiplier(COMBO_STEP * 3)).toBe(4);
    expect(comboMultiplier(10_000)).toBe(COMBO_MAX_MULTIPLIER);
  });
});

describe('the song clock', () => {
  it('starts with an empty board and a count-in before the first tile, which then comes in from the top', () => {
    const { engine, calls, t0, rate } = setup([tap(), tap()], { onBoard: false });
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, lap: 0, speedMultiplier: 1 });
    expect(calls.started).toBe(1);
    expect(engine.getTiles()).toEqual([]);

    goTo(t0 - 5 / rate); // five rows to go: the row above the board has not come up yet
    expect(engine.getTiles()).toEqual([]);
    goTo(t0 - 4 / rate);
    const tile = firstTile(engine);
    expect(tile.time).toBeCloseTo(t0, 9);
    expect(tile.yPos + TILE_HEIGHT).toBeLessThanOrEqual(0); // just above the top of the board
    goTo(t0 - IN_VIEW_ROWS / rate);
    expect(tile.yPos).toBeCloseTo(BAR_Y + TILE_HEIGHT / 2 - (IN_VIEW_ROWS + 1) * TILE_HEIGHT, 6);
  });

  it('puts the middle of each tile on the bar exactly when it is due', () => {
    const { engine } = setup([tap(), tap(), tap(), tap()]);
    const [first] = engine.getTiles();
    goTo(first.time);
    expect(centre(first)).toBeCloseTo(BAR_Y, 6);
    engine.press(first.lane, 'p1'); // (an untapped tile would end the game)

    const second = must(engine.getTiles().find((t) => t.beat === 1));
    goTo(second.time);
    expect(centre(second)).toBeCloseTo(BAR_Y, 6);
  });

  it('moves tiles at the song speed, on its own, with no taps needed', () => {
    const { engine, t0 } = setup([tap(), tap(), tap()]);
    const first = firstTile(engine);
    goTo(t0 - 1);
    const before = first.yPos;
    goTo(t0 - 0.5);
    expect(first.yPos - before).toBeCloseTo(SPEED * 0.5, 6);
  });

  it('keeps enough tiles queued to cover the board plus a row above', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().score > 3000);
    for (let i = 0; i < 20; i++) {
      step(10);
      const tiles = engine.getTiles();
      expect(tiles[tiles.length - 1].yPos).toBeLessThanOrEqual(0);
      expect(tiles.length).toBeLessThan(12); // scrolled-off tiles are recycled
    }
  });
});

describe('gaps between tiles', () => {
  it('leave real empty space: no tile is made for a rest, but its rows still pass', () => {
    const { engine, t0 } = setup([tap(), rest(3), tap(), tap()]);
    goTo(t0);
    const tiles = engine.getTiles();
    // Three empty rows between the first two tiles (the rest is beat 1 and makes no tile).
    expect(tiles.map((t) => t.start)).toEqual([0, 4]);
    expect(tiles.map((t) => t.beat)).toEqual([0, 2]);
    const [a, b] = tiles;
    expect(b.time - a.time).toBeCloseTo(4 / 2, 9); // four rows at 2 rows/s
    expect(b.yPos + TILE_HEIGHT).toBeCloseTo(a.yPos - 3 * TILE_HEIGHT, 6);
  });

  it('can open a song, and the wait is honoured', () => {
    const { engine, t0 } = setup([rest(2), tap(), tap()]);
    goTo(t0); // by now the first tile, two rows into the song, has scrolled into view
    expect(firstTile(engine).time).toBeCloseTo(t0 + 2 / 2, 9);
    tapAt(engine, firstTile(engine), 0);
    expect(engine.getState().score).toBe(POINTS.perfect);
  });

  it('give the next tile no way to be reached early across the gap, but tapping it far too soon is fatal once it is on screen', () => {
    const { engine } = setup([tap(), rest(3), tap(), tap()]);
    const first = firstTile(engine);
    tapAt(engine, first, 0);
    engine.press(must(engine.getTiles().find((t) => t.beat === 2)).lane, 'p2'); // the next tile is still off the top
    expect(engine.getState().status).toBe('playing');

    const second = must(engine.getTiles().find((t) => t.beat === 2));
    goTo(second.time - 1.1); // now it is on screen, but a whole second early
    engine.press(second.lane, 'p2');
    expect(engine.getState().status).toBe('gameover');
  });

  it('are not a miss when nothing is due: the game waits through them', () => {
    const { engine } = setup([tap(), rest(3), tap(), tap()]);
    tapAt(engine, firstTile(engine), 0);
    goTo(firstTile(engine).time + 1.5); // deep in the gap
    expect(engine.getState().status).toBe('playing');
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 2)), 0);
    expect(engine.getState().score).toBe(POINTS.perfect * 2);
  });
});

describe('the music', () => {
  // Two bars of eight taps, in C then G, with every part of the band playing something.
  const arrangement: Arrangement = {
    rowsPerBar: 4,
    chords: ['C', 'G'],
    groove: { kick: 'x...', snare: '..x.', hat: 'xoxo', bass: '1...', chord: '.x..', pad: false },
  };
  const eight = () => manyTaps(8);

  const events = (scheduled: Scheduled[], kind: MusicEvent['kind']) => scheduled.filter((s) => s.event.kind === kind);

  it('counts the player in on the beat: four ticks, a beat apart, the last a beat before the first tile', () => {
    const { scheduled, t0, rate, song } = setup(eight(), { arrangement });
    goTo(t0 - 0.4);
    const beat = song.rowsPerBeat / rate;
    const early = scheduled.filter((s) => s.at < t0 - 1e-9).sort((a, b) => a.at - b.at);
    // A kick and a hat to start the count, then a soft hat on each of the next three beats.
    expect(early.map((s) => s.event.kind)).toEqual(['kick', 'hat', 'hat', 'hat', 'hat']);
    early.forEach((s, i) => expect(s.at).toBeCloseTo(START + Math.max(0, i - 1) * beat, 9));
    expect(early[early.length - 1].at).toBeCloseTo(t0 - beat, 9);
  });

  it('schedules the drums, bass and chords row by row, in time with the tiles', () => {
    const { engine, scheduled, t0 } = setup(eight(), { arrangement });
    goTo(t0 + 3.4); // the whole first lap (8 rows = 4s) is now within the lookahead
    const kicks = events(scheduled, 'kick').filter((s) => s.at >= t0 - 1e-9);
    expect(kicks.map((s) => s.at)).toEqual([t0, t0 + 2]); // bar 1 and bar 2, four rows (2s) apart
    const snares = events(scheduled, 'snare');
    expect(snares.map((s) => s.at)).toEqual([t0 + 1, t0 + 3]);
    expect(events(scheduled, 'bass')).toHaveLength(2);
    expect(events(scheduled, 'chord')).toHaveLength(2);
    // Each row is handed over once, in order, at that row's own time.
    const hats = events(scheduled, 'hat').filter((s) => s.at >= t0 - 1e-9);
    expect(hats.map((s) => s.at)).toEqual(Array.from({ length: hats.length }, (_, i) => t0 + i / 2));
    expect(engine.getState().status).toBe('gameover'); // (nobody was tapping)
  });

  it('carries the melody too, at the moment each tile is due, whether or not it is tapped', () => {
    const beats = [tap(300), rest(), tap(400), tap(500), tap(600), rest(3)]; // two bars of four rows
    const { engine, scheduled, t0 } = setup(beats, { arrangement });
    tapAt(engine, firstTile(engine), 0.2); // late
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 2)), -0.2); // early
    goTo(t0 + 4 / 2 + 0.3); // fifth row due; the third tile was never tapped but is still scheduled
    const melody = scheduled.filter((s) => s.event.kind === 'melody');
    const rows = [0, 2, 3, 4];
    expect(melody.map((s) => (s.event as { freq: number }).freq)).toEqual([300, 400, 500, 600]);
    melody.forEach((note, i) => expect(note.at).toBeCloseTo(t0 + rows[i] / 2, 9));
  });

  it('sustains a hold for most of its length, and plays both notes of a double', () => {
    const { scheduled, engine, t0 } = setup([double(), hold(3), rest(), tap()]);
    goTo(t0 + 3);
    const melody = scheduled
      .filter((s) => s.event.kind === 'melody')
      .map((s) => s.event as { freq: number; rows?: number })
      .slice(0, 4); // (the lookahead has begun the next lap by now)
    expect(melody.map((m) => m.freq)).toEqual([440, 550, 330, 440]);
    expect(melody[0].rows).toBeUndefined();
    expect(melody[2].rows).toBeCloseTo(2.6, 9);
    expect(engine.getState().status).toBe('gameover'); // (nobody was tapping)
  });

  it('gives the audio the length of a row in seconds, and speeds up with each lap', () => {
    const { engine, scheduled, rate } = setup(manyTaps(8), { arrangement });
    playPerfectly(engine, () => engine.getState().lap >= 1);
    const lap0 = scheduled.find((s) => s.event.kind === 'kick' && s.at > START + 2);
    expect(lap0?.secondsPerRow).toBeCloseTo(1 / rate, 9);
    const before = scheduled.length;
    throughBreak(engine);
    const later = scheduled.slice(before);
    expect(later.length).toBeGreaterThan(0);
    for (const item of later) expect(item.secondsPerRow).toBeCloseTo(1 / (rate * speed(1)), 9);
  });

  it('is cut off when the game ends', () => {
    const { engine, calls, t0 } = setup(manyTaps(4), { arrangement });
    goTo(t0 - 0.3);
    engine.press((firstTile(engine).lane + 1) % 4, 'p1'); // wrong lane
    expect(engine.getState().status).toBe('gameover');
    expect(calls.stopped).toBeGreaterThanOrEqual(1);
    expect(calls.errors).toBe(1);
  });
});

describe('a recorded song', () => {
  // Row 0 is 0.13s into the recording; a row is 0.5s at this speed (2 rows per second).
  const recording: Recording = { url: 'songs/demo/audio.mp3', offset: 0.13, duration: 4.2 };
  const eight = () => manyTaps(8);

  it('starts its audio early enough that row 0 of the recording lands on the first tile', () => {
    const { engine, played, t0 } = setup(eight(), { recording });
    goTo(t0 - 1);
    expect(played).toEqual([{ url: recording.url, at: t0 - 0.13, rate: 1, notBefore: 0 }]);
    expect(engine.getState().status).toBe('playing');
  });

  it('waits until the recording is due before handing it over', () => {
    const { played, t0 } = setup(eight(), { recording });
    goTo(t0 - 1.5); // 1.37s before the audio has to start: not yet
    expect(played).toHaveLength(0);
    goTo(t0 - 1.1);
    expect(played).toHaveLength(1);
    goTo(t0 - 1);
    expect(played).toHaveLength(1); // once only
  });

  it('plays no synthesised music, apart from the count-in', () => {
    const { scheduled, t0, engine } = setup(eight(), { recording });
    goTo(t0 + 3.4);
    expect(scheduled.filter((s) => s.at >= t0 - 1e-9)).toEqual([]);
    expect(scheduled.map((s) => s.event.kind).sort()).toEqual(['hat', 'hat', 'hat', 'hat', 'kick']);
    expect(engine.getState().status).toBe('gameover'); // (nobody was tapping)
  });

  it('plays the recording again, faster, on every lap, still on the beat', () => {
    const { engine, played, rate, timeline } = setup(eight(), { recording });
    const due = new Map<number, number>(); // beat -> when its tile is due (tiles are removed once cleared)
    playPerfectly(engine, () => {
      for (const tile of engine.getTiles()) due.set(tile.beat, tile.time);
      return engine.getState().lap >= 2;
    });
    goTo(timeline.lapStart(2) - 0.5); // through the rest, into the count-in of lap 2
    expect(played.map((p) => p.rate)).toEqual([1, 2, 3].map((n) => expect.closeTo(speed(n - 1), 9)));

    // Every lap, row `k` of the recording (offset + k rows in) arrives exactly when its tile is due.
    const rowSeconds = 1 / rate;
    for (const lap of [0, 1]) {
      const { at, rate: speed } = played[lap];
      expect(at + (recording.offset + 3 * rowSeconds) / speed).toBeCloseTo(must(due.get(lap * 8 + 3)), 9);
    }
  });

  it('never hands over more than a couple of laps in one frame', () => {
    const { played, engine, calls, t0 } = setup(eight(), { recording });
    goTo(t0 + 1000); // a huge jump, as after a long freeze
    expect(played.length).toBeLessThanOrEqual(2);
    expect(engine.getState().status).toBe('gameover');
    expect(calls.stopped).toBeGreaterThanOrEqual(1);
  });
});

describe('timing judgments', () => {
  it.each([
    [0, 'perfect', POINTS.perfect],
    [0.06, 'perfect', POINTS.perfect],
    [0.095, 'perfect', POINTS.perfect],
    [-0.095, 'perfect', POINTS.perfect],
    [-0.06, 'perfect', POINTS.perfect],
    [-0.12, 'good', POINTS.good],
    [0.17, 'good', POINTS.good],
    [0.14, 'good', POINTS.good],
    [-0.22, 'ok', POINTS.ok],
    [0.22, 'ok', POINTS.ok],
  ] as const)('a tap %ss from the bar is %s', (offset, judgment, points) => {
    const { engine } = setup([tap(), tap()]);
    tapAt(engine, firstTile(engine), offset);
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().score).toBe(points);
    expect(engine.getState().combo).toBe(judgment === 'perfect' ? 1 : 0);
  });

  describe('the popup', () => {
    /** Taps the first tile `offset` seconds off the bar and returns what the effects were asked to show. */
    function popupFor(offset: number) {
      const popups: { text: string; options?: Parameters<Fx['popup']>[3] }[] = [];
      const effects: Fx = { ...noopFx, popup: (text, _x, _y, options) => popups.push({ text, options }) };
      const { engine } = setup([tap(), tap()], { effects });
      tapAt(engine, firstTile(engine), offset);
      return must(popups.at(-1));
    }

    it('says nothing of timing for a perfect hit', () => {
      const { options } = popupFor(0.05);
      expect(options).toMatchObject({ judgment: 'perfect', sub: `+${POINTS.perfect}` });
      expect(options?.timing).toBeUndefined();
    });

    it.each([
      [-0.14, 'good', 'early'],
      [0.14, 'good', 'late'],
      [-0.22, 'ok', 'early'],
      [0.22, 'ok', 'late'],
    ] as const)('marks a tap %ss from the bar as %s and %s', (offset, judgment, timing) => {
      const { options } = popupFor(offset);
      expect(options).toMatchObject({ judgment, timing, sub: `+${POINTS[judgment]}` });
    });
  });

  it('ends the game if a tile is tapped too early to line up with the bar', () => {
    for (const offset of [-OK_WINDOW - 0.01, -0.4, -0.7]) {
      const { engine, results } = setup([tap(), tap()]);
      tapAt(engine, firstTile(engine), offset);
      expect(engine.getState().status).toBe('gameover');
      expect(results[0]).toMatchObject({ reason: 'early', score: 0 });
    }
  });

  it('ends the game if a tap comes too late to line up, even between frames', () => {
    const { engine, results } = setup([tap(), tap()]);
    const tile = firstTile(engine);
    goTo(tile.time + 0.1);
    songTime = tile.time + OK_WINDOW + 0.01; // the clock moves on before the next frame
    engine.press(tile.lane, 'p1');
    expect(engine.getState().status).toBe('gameover');
    expect(results[0].reason).toBe('miss');
  });

  it('says how far off a tap was that ended the game, and nothing for a tile that was never tapped', () => {
    const early = setup([tap(), tap()]);
    tapAt(early.engine, firstTile(early.engine), -0.4);
    expect(early.results[0]).toMatchObject({ reason: 'early', by: 400 });

    const late = setup([tap(), tap()]);
    const tile = firstTile(late.engine);
    goTo(tile.time + 0.1);
    songTime = tile.time + 0.31;
    late.engine.press(tile.lane, 'p1');
    expect(late.results[0]).toMatchObject({ reason: 'miss', by: 310 });

    const never = setup([tap(), tap()]);
    goTo(firstTile(never.engine).time + OK_WINDOW + 0.05);
    expect(never.results[0].reason).toBe('miss');
    expect(never.results[0].by).toBeUndefined();
  });

  describe('a tap that the page only heard of after a delay', () => {
    it('is graded at the moment it happened, not the moment it was heard', () => {
      const { engine, results } = setup([tap(), tap()]);
      const tile = firstTile(engine);
      songTime = tile.time + 0.35; // a stall: no frame has run, and the finger landed 0.3 s ago, right on the bar
      engine.press(tile.lane, 'p1', 0.3);
      expect(engine.getState()).toMatchObject({ status: 'playing', score: POINTS.perfect });
      expect(results).toHaveLength(0);
    });

    it('is a miss all the same if it happened too late', () => {
      const { engine, results } = setup([tap(), tap()]);
      const tile = firstTile(engine);
      songTime = tile.time + 0.55;
      engine.press(tile.lane, 'p1', 0.2); // it landed 0.35 s after the bar
      expect(results[0]).toMatchObject({ reason: 'miss', by: 350 });
    });

  });

  it('ignores a press before the next tile is even on screen', () => {
    const { engine, t0, rate } = setup([tap(), tap()], { onBoard: false });
    goTo(t0 - 4 / rate); // the first tile has been laid out, still above the top of the board
    engine.press(firstTile(engine).lane, 'p1');
    engine.press((firstTile(engine).lane + 1) % 4, 'p1');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0 });
  });

  it('counts each judgment in the final stats', () => {
    const { engine, results } = setup([tap(), tap(), tap(), tap()]);
    tapAt(engine, firstTile(engine), 0); // perfect
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 1)), 0.14); // good
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 2)), -0.2); // ok
    goTo(must(engine.getTiles().find((t) => t.beat === 3)).time + OK_WINDOW + 0.05); // miss the last
    expect(engine.getState().status).toBe('gameover');
    expect(results[0]).toMatchObject({ reason: 'miss', score: POINTS.perfect + POINTS.good + POINTS.ok });
    expect(results[0].stats).toMatchObject({ perfect: 1, good: 1, ok: 1, tiles: 3, maxChain: 1 });
  });
});

describe('chains of perfects', () => {
  it('raise the points every tile is worth', () => {
    const { engine, states } = setup(manyTaps(80));
    let expected = 0;
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP * 2 + 2);
    for (let combo = 0; combo < COMBO_STEP * 2 + 2; combo++) expected += POINTS.perfect * comboMultiplier(combo);
    expect(engine.getState().score).toBe(expected);
    expect(engine.getState().comboMultiplier).toBe(3);
    expect(states.find((s) => s.combo === COMBO_STEP)?.comboMultiplier).toBe(2);
    expect(states.find((s) => s.combo === COMBO_STEP - 1)?.comboMultiplier).toBe(1);
  });

  it('step up every few perfects, so the first raise comes early', () => {
    expect(COMBO_STEP).toBeLessThanOrEqual(5);
    expect(comboMultiplier(COMBO_STEP - 1)).toBe(1);
    expect(comboMultiplier(COMBO_STEP)).toBe(2);
  });

  it('are broken by a hit that is only good, or early or late by more than a perfect allows', () => {
    for (const offset of [0.14, -0.14]) {
      const { engine } = setup(manyTaps(80));
      playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP + 1);
      expect(engine.getState().comboMultiplier).toBe(2);
      const scoreBefore = engine.getState().score;

      tapAt(engine, nextBeat(engine)[0], offset); // merely good
      expect(engine.getState()).toMatchObject({ status: 'playing', combo: 0, comboMultiplier: 1 });
      expect(engine.getState().score - scoreBefore).toBe(POINTS.good * 2); // still earned at the old multiplier
      const after = engine.getState().score;
      tapAt(engine, nextBeat(engine)[0], 0);
      expect(engine.getState().combo).toBe(1);
      expect(engine.getState().score - after).toBe(POINTS.perfect);
    }
  });

  it('are broken by a hit that is only ok', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP + 1);
    expect(engine.getState().comboMultiplier).toBe(2);
    const scoreBefore = engine.getState().score;

    tapAt(engine, nextBeat(engine)[0], -0.22); // ok
    expect(engine.getState()).toMatchObject({ combo: 0, comboMultiplier: 1 });
    expect(engine.getState().score - scoreBefore).toBe(POINTS.ok * 2); // still earned at the old multiplier
    const after = engine.getState().score;
    tapAt(engine, nextBeat(engine)[0], 0);
    expect(engine.getState().score - after).toBe(POINTS.perfect);
  });

  it('stop growing at the maximum multiplier', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP * COMBO_MAX_MULTIPLIER + 3, 2000);
    expect(engine.getState().comboMultiplier).toBe(COMBO_MAX_MULTIPLIER);
  });
});

describe('failing', () => {
  it('a tap in a lane with no tile in it ends the game', () => {
    const { engine, results } = setup([tap(), tap()]);
    const tile = firstTile(engine);
    goTo(tile.time);
    engine.press((tile.lane + 1) % 4, 'p1');
    expect(engine.getState().status).toBe('gameover');
    expect(results).toEqual([expect.objectContaining({ score: 0, isNewBest: false, reason: 'wrong' })]);
  });

  it('a tile left too late is missed, and the board slides back to show it on the bar', () => {
    const { engine, results } = setup([tap(), tap()]);
    const tile = firstTile(engine);
    goTo(tile.time + OK_WINDOW - 0.01);
    expect(engine.getState().status).toBe('playing'); // still hittable
    goTo(tile.time + OK_WINDOW + 0.01);
    expect(engine.getState().status).toBe('gameover');
    expect(centre(tile)).toBeCloseTo(BAR_Y, 6);
    expect(results[0].reason).toBe('miss');
  });

  it('saves the run', () => {
    const { engine } = setup([tap(), tap()]);
    tapAt(engine, firstTile(engine), 0);
    goTo(engine.getTiles()[0].time + 5);
    expect(engine.getState().status).toBe('gameover');
    engine.finish(); // (a run with something to continue on is only saved once that is turned down)
    expect(getBest('test')).toBe(POINTS.perfect);
  });

  it('a hurried repeat tap on a lane just cleared is forgiven, a late one is not', () => {
    const { engine } = setup([tap(), tap(), tap()]);
    const first = firstTile(engine);
    goTo(first.time - 0.3); // let the next tile spawn
    const second = must(engine.getTiles().find((t) => t.beat === 1));
    if (second.lane === first.lane) second.lane = (first.lane + 1) % 4; // make sure the repeat lands in an empty lane
    tapAt(engine, first, 0);
    goTo(first.time + 0.05);
    engine.press(first.lane, 'p1');
    expect(engine.getState().status).toBe('playing');
    goTo(first.time + 0.2);
    engine.press(first.lane, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('cannot be avoided by tapping a lane that only a later beat uses', () => {
    const { engine } = setup([tap(), tap(), tap()]);
    const first = firstTile(engine);
    goTo(first.time - 0.3); // let the next tile spawn
    const later = must(engine.getTiles().find((t) => t.beat === 1));
    later.lane = (first.lane + 1) % 4;
    goTo(first.time);
    engine.press(later.lane, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });
});

describe('lives', () => {
  /** A run with the game's own lives that has cleared tiles perfectly until the chain is `count` long. */
  function played(count: number, options: SetupOptions & { beats?: BeatSpec[] } = {}) {
    const popups: string[] = [];
    const effects: Fx = { ...noopFx, popup: (text) => popups.push(text) };
    const { beats = manyTaps(80), ...rest } = options;
    const made = setup(beats, { lives: LIVES, effects, ...rest });
    playPerfectly(made.engine, () => made.engine.getState().combo >= count);
    return { ...made, popups };
  }

  /** Let the next tile go by untouched, on to the moment it is missed. */
  function letGo(engine: GameEngine): void {
    goTo(nextBeat(engine)[0].time + OK_WINDOW + 0.01);
  }

  it('start full, and are shown in the state', () => {
    const { engine } = setup(manyTaps(20), { lives: LIVES });
    expect(engine.getState().lives).toBe(LIVES);
  });

  it('are lost, one by one, to a tile that is missed, and the run goes on with the chain gone', () => {
    const { engine, results, calls } = played(COMBO_STEP + 1);
    expect(engine.getState()).toMatchObject({ lives: LIVES, comboMultiplier: 2 });
    const doomed = nextBeat(engine)[0];

    letGo(engine);
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES - 1, combo: 0, comboMultiplier: 1 });
    expect(doomed.isHit).toBe(true); // (left behind)
    expect(calls.errors).toBe(1);
    expect(results).toHaveLength(0);

    // The next tile is on the board, and taking it starts a new chain.
    const next = nextBeat(engine)[0];
    expect(next.beat).toBe(doomed.beat + 1);
    const before = engine.getState().score;
    tapAt(engine, next, 0);
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES - 1, combo: 1 });
    expect(engine.getState().score - before).toBe(POINTS.perfect);
  });

  it('are lost to a tap that is too early, and that tile is still there to be tapped', () => {
    const { engine, results } = played(3);
    const tile = nextBeat(engine)[0];
    tapAt(engine, tile, -OK_WINDOW - 0.05);
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES - 1, combo: 0 });
    expect(tile.isHit).toBe(false);
    expect(results).toHaveLength(0);
    tapAt(engine, tile, 0);
    expect(tile.isHit).toBe(true);
    expect(engine.getState()).toMatchObject({ lives: LIVES - 1, combo: 1 });
  });

  it('are lost to a tap in a lane with no tile in it', () => {
    const { engine, results } = played(3);
    const tile = nextBeat(engine)[0];
    goTo(tile.time);
    engine.press((tile.lane + 1) % 4, 'p1');
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES - 1, combo: 0 });
    expect(tile.isHit).toBe(false);
    expect(results).toHaveLength(0);
    engine.press(tile.lane, 'p1');
    expect(tile.isHit).toBe(true);
  });

  it('are lost one at a time when mistakes come close together, however many taps make the fumble', () => {
    const { engine } = played(3);
    const tile = nextBeat(engine)[0];
    goTo(tile.time - 0.1);
    for (let i = 0; i < 4; i++) {
      engine.press((tile.lane + 1) % 4, 'p1'); // (four blank taps in a row are one mistake)
      songTime += (STRIKE_GRACE - 0.05) / 3;
    }
    expect(engine.getState().lives).toBe(LIVES - 1);
    songTime += STRIKE_GRACE;
    engine.press((tile.lane + 1) % 4, 'p1');
    expect(engine.getState().lives).toBe(LIVES - 2);
  });

  it('cost one life for a double of which neither tile is tapped', () => {
    const { engine } = played(1, { beats: [tap(), double(), tap(), tap(), tap(), tap()] });
    expect(nextBeat(engine)).toHaveLength(2);
    letGo(engine);
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES - 1 });
    expect(nextBeat(engine)[0].beat).toBe(2);
  });

  it('end the run when the last one goes, and the game over says what did it', () => {
    const { engine, results } = played(3);
    for (let i = 0; i < LIVES - 1; i++) {
      letGo(engine);
      expect(engine.getState().status).toBe('playing');
    }
    expect(engine.getState().lives).toBe(1);
    letGo(engine);
    expect(engine.getState()).toMatchObject({ status: 'gameover', lives: 0 });
    expect(results).toEqual([expect.objectContaining({ reason: 'miss' })]);

    const wrong = played(3);
    for (let i = 0; i < LIVES; i++) {
      const tile = nextBeat(wrong.engine)[0];
      goTo(tile.time - 0.2);
      wrong.engine.press((tile.lane + 1) % 4, 'p1');
      goTo(tile.time);
      wrong.engine.press(tile.lane, 'p1'); // (the tile is tapped in the end: it is the blank taps that cost the lives)
    }
    expect(wrong.engine.getState().status).toBe('gameover');
    expect(wrong.results[0].reason).toBe('wrong');
  });

  it('come back, one for every LIFE_CHAIN perfects in a row, but never beyond the full number', () => {
    const { engine, popups } = played(1);
    letGo(engine);
    letGo(engine);
    expect(engine.getState().lives).toBe(LIVES - 2);
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN - 1);
    expect(engine.getState()).toMatchObject({ lives: LIVES - 2, combo: LIFE_CHAIN - 1 });
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN);
    expect(engine.getState().lives).toBe(LIVES - 1);
    expect(popups).toContain('+1 LIFE');
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN * 2);
    expect(engine.getState().lives).toBe(LIVES);
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN * 3);
    expect(engine.getState().lives).toBe(LIVES);
  });

  it('are not won back by a chain that a good hit cut short', () => {
    const { engine } = played(1);
    letGo(engine);
    expect(engine.getState().lives).toBe(LIVES - 1);
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN - 1);
    tapAt(engine, nextBeat(engine)[0], 0.14); // good: the chain is over
    expect(engine.getState().combo).toBe(0);
    playPerfectly(engine, () => engine.getState().combo >= LIFE_CHAIN - 1);
    expect(engine.getState().lives).toBe(LIVES - 1);
  });

  it('are all back after a continue, and for a new game', () => {
    const made = played(6, { beats: manyTaps(16) });
    const { engine } = made;
    for (let i = 0; i < LIVES; i++) {
      letGo(engine);
      songTime += STRIKE_GRACE;
    }
    expect(engine.getState()).toMatchObject({ status: 'gameover', lives: 0 });
    expect(engine.canContinue()).toBe(true);

    engine.continueRun();
    expect(engine.getState()).toMatchObject({ status: 'playing', lives: LIVES, combo: 0 });

    songTime = 900;
    engine.start(made.song);
    expect(engine.getState().lives).toBe(LIVES);
  });

  it('give the continue only when the last is gone, not for a mistake with lives to spare', () => {
    const { engine, results } = played(4, { beats: manyTaps(16) });
    letGo(engine);
    expect(engine.getState().status).toBe('playing');
    expect(engine.canContinue()).toBe(false);
    expect(results).toHaveLength(0);
    letGo(engine);
    letGo(engine);
    expect(engine.getState().status).toBe('gameover');
    expect(engine.canContinue()).toBe(true);
    expect(results).toEqual([expect.objectContaining({ continueScore: expect.any(Number) })]);
  });
});

describe('double tiles', () => {
  it('lay two tiles in one row, in a pair of lanes that are never neighbours', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const { engine } = setup([double(), double()]);
      const [left, right] = engine.getTiles();
      expect(left.yPos).toBe(right.yPos);
      expect(left.beat).toBe(right.beat);
      expect(left.time).toBe(right.time);
      expect(right.lane - left.lane).toBeGreaterThanOrEqual(2);
      expect(DOUBLE_LANES.map((pair) => pair.join())).toContain([left.lane, right.lane].join());
      expect([left.freq, right.freq]).toEqual([440, 550]);
      seen.add([left.lane, right.lane].join());
    }
    // Two thumbs on the outside lanes are among them, and so are both pairs with a lane between.
    expect([...seen].sort()).toEqual(DOUBLE_LANES.map((pair) => pair.join()).sort());
    expect(seen.has('0,3')).toBe(true);
  });

  it('need both tiles tapped, each graded on its own, before the beat is cleared', () => {
    const { engine } = setup([double(), tap(), tap()]);
    const [left, right] = engine.getTiles();
    tapAt(engine, right, 0);
    expect(engine.getState().score).toBe(POINTS.perfect);
    expect(nextBeat(engine).map((t) => t.id)).toContain(left.id);

    tapAt(engine, left, 0.14);
    expect(engine.getState().score).toBe(POINTS.perfect + POINTS.good);
    expect(nextBeat(engine)[0].beat).toBe(left.beat + 1);
  });

  it('are missed if only one of the pair gets tapped', () => {
    const { engine, t0 } = setup([double(), tap()]);
    tapAt(engine, engine.getTiles()[0], 0);
    goTo(t0 + OK_WINDOW + 0.05);
    expect(engine.getState().status).toBe('gameover');
  });

  it('end the game when the lane between the pair is tapped', () => {
    const { engine } = setup([double(), tap()]);
    const [left] = engine.getTiles();
    goTo(left.time);
    engine.press(left.lane + 1, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('ignore a repeat press on a lane already cleared', () => {
    const { engine } = setup([double(), tap()]);
    const [left, right] = engine.getTiles();
    tapAt(engine, left, 0);
    engine.press(left.lane, 'p1');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: POINTS.perfect });
    engine.press(right.lane, 'p2');
    expect(engine.getState().score).toBe(POINTS.perfect * 2);
  });
});

describe('double holds', () => {
  function setupDoubleHold(rows = 3, speed = SPEED) {
    const context = setup([doubleHold(rows), tap(), tap()], { speed });
    const [left, right] = context.engine.getTiles();
    return { ...context, left, right, spacing: 0.5 / context.rate };
  }

  it('lay two hold tiles in one row, never neighbours, each as tall as the hold is long', () => {
    for (let i = 0; i < 20; i++) {
      const { engine, left, right, t0, rate } = setupDoubleHold(3);
      expect(engine.getTiles().filter((t) => t.beat === 0)).toHaveLength(2);
      expect(right.lane - left.lane).toBeGreaterThanOrEqual(2);
      expect(DOUBLE_LANES.map((pair) => pair.join())).toContain([left.lane, right.lane].join());
      expect([left.rows, right.rows]).toEqual([3, 3]);
      expect(left.time).toBe(right.time);
      expect([left.freq, right.freq]).toEqual([440, 550]);
      for (const tile of [left, right]) {
        expect(tile.hold?.totalTicks).toBe(5);
        expect(must(tile.hold).end).toBeCloseTo(t0 + 2.5 / rate, 9);
      }
    }
  });

  it('are held with two fingers, each tile graded on its own and paying its own ticks', () => {
    const { engine, left, right } = setupDoubleHold();
    tapAt(engine, left, -0.14, 'p1'); // good
    expect(engine.getState().score).toBe(POINTS.good);
    tapAt(engine, right, 0, 'p2'); // perfect
    expect(engine.getState().score).toBe(POINTS.good + POINTS.perfect);
    expect(left.hold?.phase).toBe('holding');
    expect(right.hold?.phase).toBe('holding');

    goTo(must(left.hold).end);
    expect(left.hold?.phase).toBe('done');
    expect(right.hold?.phase).toBe('done');
    // Both fingers stayed down to the end, so both paid every tick: the early one is held longer than it is due.
    expect(engine.getState().score).toBe(POINTS.good + POINTS.perfect + 2 * 5 * HOLD_TICK_POINTS);
    expect(engine.getState().status).toBe('playing');
    expect(nextBeat(engine)[0].beat).toBe(1);
  });

  it('can have one finger lifted while the other keeps paying', () => {
    const { engine, left, right, t0, spacing } = setupDoubleHold();
    tapAt(engine, left, 0, 'p1');
    tapAt(engine, right, 0, 'p2');
    goTo(t0 + spacing * 2 + 0.05);
    engine.release('p1');
    expect(engine.getState().status).toBe('playing');
    expect(left.hold?.phase).not.toBe('holding');
    expect(right.hold?.phase).toBe('holding');

    goTo(must(right.hold).end);
    expect(right.hold?.phase).toBe('done');
    expect(engine.getState().score).toBe(2 * POINTS.perfect + (2 + 5) * HOLD_TICK_POINTS);
    expect(engine.getState().status).toBe('playing');
  });

  it('survive two quick taps, one per finger, that are over almost as soon as they began', () => {
    // What a touchscreen often makes of a "hold": each finger is down for 10-20 ms.
    const { engine, left, right, t0 } = setupDoubleHold();
    goTo(t0);
    engine.press(left.lane, 'p1');
    engine.press(right.lane, 'p2');
    songTime = t0 + 0.012;
    engine.release('p1');
    songTime = t0 + 0.02;
    engine.release('p2');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 2 * POINTS.perfect });
    expect([left.isHit, right.isHit]).toEqual([true, true]);

    const next = must(engine.getTiles().find((t) => t.beat === 1));
    tapAt(engine, next, 0, 'p3');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 3 * POINTS.perfect });
  });

  it('let the next tile be tapped when one half was let go of early and the other is still held', () => {
    const { engine, left, right, t0 } = setupDoubleHold(3, 100);
    tapAt(engine, left, 0, 'p1');
    tapAt(engine, right, 0, 'p2');
    goTo(t0 + 0.3);
    engine.release('p1');
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    next.lane = left.lane + 1; // (the lane between the pair: neither half's own)
    const at = t0 + 0.55;
    expect(at).toBeLessThan(must(right.hold).end);
    expect(next.time - at).toBeLessThanOrEqual(OK_WINDOW);
    goTo(at);
    engine.press(next.lane, 'p3');
    expect(engine.getState().status).toBe('playing');
    expect(right.hold?.phase).toBe('done'); // let go of to move on, keeping what it had paid
    expect(next.isHit).toBe(true);
  });

  it('are missed if one of the two is never pressed', () => {
    const { engine, left, t0 } = setupDoubleHold();
    tapAt(engine, left, 0);
    goTo(t0 + DOUBLE_HOLD_LATE_WINDOW + 0.05);
    expect(engine.getState().status).toBe('gameover');
  });

  it('are given longer than any other tile to be grabbed late, since they are the hardest to get to', () => {
    const { engine, results, left, t0 } = setupDoubleHold();
    tapAt(engine, left, 0);
    goTo(t0 + OK_WINDOW + 0.05); // (a single tile would be missed by now)
    expect(engine.getState().status).toBe('playing');
    goTo(t0 + DOUBLE_HOLD_LATE_WINDOW - 0.02);
    expect(engine.getState().status).toBe('playing');
    goTo(t0 + DOUBLE_HOLD_LATE_WINDOW + 0.02);
    expect(results[0]).toMatchObject({ reason: 'miss' });
  });

  it('can be grabbed late with both fingers, and each half then counts as an OK', () => {
    const { engine, results, left, right, t0 } = setupDoubleHold();
    goTo(t0 + 0.45);
    engine.press(left.lane, 'p1');
    engine.press(right.lane, 'p2');
    expect(results).toHaveLength(0);
    expect(engine.getState().score).toBe(2 * POINTS.ok);
    expect(left.hold?.phase).toBe('holding');
    expect(right.hold?.phase).toBe('holding');
  });

  it('are no more forgiving early than any other tile', () => {
    const { engine, results, left } = setupDoubleHold();
    goTo(left.time - OK_WINDOW - 0.05);
    engine.press(left.lane, 'p1');
    expect(results[0]).toMatchObject({ reason: 'early' });
  });

  it('are the only tiles with the longer late window', () => {
    for (const beats of [[double(), tap()], [hold(2), tap()], [tap(), tap()]]) {
      const { engine, t0 } = setup(beats);
      goTo(t0 + OK_WINDOW + 0.05);
      expect(engine.getState().status).toBe('gameover');
    }
  });

  it('end the game when the lane between the pair is tapped', () => {
    const { engine, left } = setupDoubleHold();
    goTo(left.time);
    engine.press(left.lane + 1, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });
});

describe('the readout of what is due', () => {
  /** Play `beats` perfectly with a listener on the trace, and hand back the "due" lines it heard, in order. */
  function dueLines(beats: BeatSpec[]): string[] {
    const heard: string[] = [];
    listenToTrace((line) => heard.push(line));
    try {
      const { engine } = setup(beats);
      playPerfectly(engine, () => false, beats.length);
    } finally {
      listenToTrace(null);
    }
    return heard.filter((line) => line.startsWith('due'));
  }

  it('says when a double, a hold or a double hold comes due, and says nothing of plain taps', () => {
    const lines = dueLines([tap(), double(), tap(), hold(2), doubleHold(2), tap(), tap(), tap()]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^due: double in L[0-3] and L[0-3]$/);
    expect(lines[1]).toMatch(/^due: hold in L[0-3]$/);
    expect(lines[2]).toMatch(/^due: double hold in L(0 and L2|1 and L3|0 and L3)$/);
  });

  it('says nothing at all for a song of plain taps', () => {
    expect(dueLines(manyTaps(6))).toEqual([]);
  });
});

describe('hold tiles', () => {
  /** [hold, tap, tap]: the hold comes first so its head and far end are easy to reason about. */
  function setupHold(rows = 3, speed = SPEED) {
    const context = setup([hold(rows), tap(), tap()], { speed });
    return { ...context, tile: firstTile(context.engine), spacing: 0.5 / context.rate };
  }

  it.each([2, 3, 4])('are %i rows tall and complete when their far end reaches the bar', (rows) => {
    const { engine, tile, t0, rate } = setupHold(rows);
    goTo(t0); // let the next tile spawn
    expect(tile.rows).toBe(rows);
    const hold = must(tile.hold);
    expect(hold.end).toBeCloseTo(t0 + (rows - 0.5) / rate, 9);
    expect(hold.totalTicks).toBe(rows * 2 - 1);
    // The hold ends half a row before the next tile arrives: a breather.
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    expect(next.time - hold.end).toBeCloseTo(0.5 / rate, 9);
  });

  it('are pressed at the head, graded like a tap, then pay out steadily while held', () => {
    const { engine, tile, t0, spacing } = setupHold();
    tapAt(engine, tile, 0);
    expect(tile.hold?.phase).toBe('holding');
    expect(tile.isHit).toBe(false);
    expect(engine.getState().score).toBe(POINTS.perfect);

    goTo(t0 + spacing * 2 + 0.001);
    expect(engine.getState().score).toBe(POINTS.perfect + 2 * HOLD_TICK_POINTS);
    goTo(must(tile.hold).end);
    expect(tile.hold?.phase).toBe('done');
    expect(tile.isHit).toBe(true);
    expect(engine.getState().score).toBe(POINTS.perfect + 5 * HOLD_TICK_POINTS);
    expect(engine.getState().status).toBe('playing');
  });

  it('pay more the longer they are', () => {
    const totals = [2, 4].map((rows) => {
      const { engine, tile } = setupHold(rows);
      tapAt(engine, tile, 0);
      goTo(must(tile.hold).end);
      return engine.getState().score - POINTS.perfect;
    });
    expect(totals).toEqual([3 * HOLD_TICK_POINTS, 7 * HOLD_TICK_POINTS]);
  });

  it('can be let go at any point without losing: you just stop earning', () => {
    const { engine, tile, t0, spacing } = setupHold();
    tapAt(engine, tile, 0);
    goTo(t0 + spacing * 2 + 0.05);
    engine.release('p1');
    expect(engine.getState().status).toBe('playing');
    expect(tile.isHit).toBe(true);
    const kept = POINTS.perfect + 2 * HOLD_TICK_POINTS;
    expect(engine.getState().score).toBe(kept);

    goTo(must(tile.hold).end + 0.01); // the rest of the hold would have paid 30 more
    expect(engine.getState().score).toBe(kept);
    expect(engine.getState().status).toBe('playing');
  });

  it('pay for the ticks up to the moment of release, even between frames', () => {
    const { engine, tile, t0, spacing } = setupHold();
    tapAt(engine, tile, 0);
    songTime = t0 + spacing * 3 + 0.01; // no frame has run since
    engine.release('p1');
    expect(engine.getState().score).toBe(POINTS.perfect + 3 * HOLD_TICK_POINTS);
  });

  it('pay only up to when the finger really came up, if the page heard of it late', () => {
    const { engine, tile, t0, spacing } = setupHold();
    tapAt(engine, tile, 0);
    goTo(t0 + spacing * 2.2);
    // The finger came up 2.5 spacings in and the page heard of it 0.7 spacings later, between frames:
    // two ticks had been earned by then, not three.
    songTime = t0 + spacing * 3.2;
    engine.release('p1', spacing * 0.7);
    expect(tile.hold?.phase).toBe('done');
    expect(engine.getState().score).toBe(POINTS.perfect + 2 * HOLD_TICK_POINTS);
  });

  it('can be released the instant after pressing, keeping the tap points', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0);
    engine.release('p1');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: POINTS.perfect });
    expect(tile.isHit).toBe(true);
  });

  it('do not pay for the part that went by before a late grab', () => {
    const { engine, tile, spacing } = setupHold(3, 100);
    tapAt(engine, tile, 0.2); // ok, and late enough to have missed a tick or so
    const missed = Math.floor(0.2 / spacing);
    expect(missed).toBeGreaterThan(0);
    goTo(must(tile.hold).end);
    expect(engine.getState().score).toBe(POINTS.ok + (5 - missed) * HOLD_TICK_POINTS);
  });

  it('use the chain multiplier for their ticks', () => {
    const { engine } = setup([...manyTaps(COMBO_STEP), hold(3), tap()]);
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP);
    const before = engine.getState().score;
    const tile = must(nextBeat(engine)[0]);
    tapAt(engine, tile, 0);
    goTo(must(tile.hold).end);
    expect(engine.getState().score - before).toBe(POINTS.perfect * 2 + 5 * HOLD_TICK_POINTS * 2);
  });

  it('are missed if never pressed', () => {
    const { engine, t0 } = setupHold();
    goTo(t0 + OK_WINDOW + 0.05);
    expect(engine.getState().status).toBe('gameover');
  });

  it('end the game if grabbed too early to line up with the bar', () => {
    const { engine, tile, results } = setupHold();
    tapAt(engine, tile, -0.4);
    expect(engine.getState().status).toBe('gameover');
    expect(results[0].reason).toBe('early');
  });

  it('ignore a second finger while one is already holding', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0, 'p1');
    engine.press(tile.lane, 'p2');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: POINTS.perfect });
    expect(tile.hold?.pointer).toBe('p1');
  });

  it('let go when the next tile is tapped, so back-to-back tiles are not a trap', () => {
    // At this speed the next tile can be tapped (a little early) before the hold has finished.
    const { engine, tile, t0, rate } = setupHold(3, 100);
    tapAt(engine, tile, 0);
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    next.lane = (tile.lane + 1) % 4;
    const at = t0 + 0.55;
    expect(at).toBeLessThan(must(tile.hold).end);
    expect(next.time - at).toBeLessThanOrEqual(OK_WINDOW);
    goTo(at);
    engine.press(next.lane, 'p2');
    expect(engine.getState().status).toBe('playing');
    expect(tile.hold?.phase).toBe('done'); // released, keeping what it had paid
    expect(next.isHit).toBe(true);
    const ticks = Math.floor(0.55 / (0.5 / rate));
    expect(engine.getState().score).toBe(POINTS.perfect + ticks * HOLD_TICK_POINTS + POINTS.ok);
  });

  it('still end the game if a lane with no tile in it is tapped while holding', () => {
    const { engine, tile, t0 } = setupHold(3, 100);
    tapAt(engine, tile, 0);
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    next.lane = (tile.lane + 2) % 4;
    goTo(t0 + 0.3);
    engine.press((tile.lane + 1) % 4, 'p2'); // neither the held tile's lane nor the next tile's
    expect(engine.getState().status).toBe('gameover');
  });

  it('do not mistake a second finger in the held lane for the next tile, even when that is in the same lane', () => {
    for (let i = 0; i < 8; i++) {
      const { engine, tile, t0 } = setupHold(3, 100);
      tapAt(engine, tile, 0);
      const next = must(engine.getTiles().find((t) => t.beat === 1));
      next.lane = tile.lane; // the worst case: the next tile is right above the held one
      goTo(t0 + 0.2); // it is nowhere near due
      engine.press(tile.lane, 'p2');
      expect(engine.getState().status).toBe('playing');
      expect(tile.hold?.phase).toBe('holding');
    }
  });

  it('work from the keyboard too', () => {
    const { engine, tile, t0, spacing } = setupHold();
    goTo(t0);
    engine.press(tile.lane, 'k:KeyD');
    expect(tile.hold?.phase).toBe('holding');
    goTo(t0 + spacing * 2 + 0.05);
    engine.release('k:KeyD');
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().score).toBe(POINTS.perfect + 2 * HOLD_TICK_POINTS);
  });
});

describe('laps: the song ends and everything speeds up', () => {
  it('adds 0.2x to the speed each time the song finishes: 1x, 1.2x, 1.4x, 1.6x', () => {
    const { engine, calls, states } = setup(manyTaps(4));
    playPerfectly(engine, () => engine.getState().lap >= 3);
    expect(engine.getState().status).toBe('playing');
    const speeds = [0, 1, 2, 3].map((lap) => states.find((s) => s.lap === lap)?.speedMultiplier);
    expect(speeds).toEqual([1, 1.2, 1.4, 1.6]);
    expect(calls.levelUps).toBe(3);
    expect(engine.getState().speedMultiplier).toBe(1.6);
  });

  it('starts the next lap after a rest and a count-in, and plays it faster', () => {
    const { engine, scheduled, timeline } = setup(manyTaps(4));
    playPerfectly(engine, () => engine.getState().lap >= 1);
    expect(engine.getState().lap).toBe(1);
    const lap1Start = timeline.lapStart(1);
    expect(lap1Start).toBeGreaterThan(timeline.lapEnd(0) + LAP_REST_SECONDS);
    goTo(lap1Start + 1);
    const melody = scheduled.filter((s) => s.event.kind === 'melody');
    const lap0Gap = melody[1].at - melody[0].at;
    const lap1 = melody.filter((n) => n.at >= timeline.lapEnd(0));
    expect(lap1[0].at).toBeCloseTo(lap1Start, 9);
    expect(lap1[1].at - lap1[0].at).toBeCloseTo(lap0Gap / speed(1), 9);
  });

  it('makes tiles fall faster on later laps', () => {
    const { engine } = setup(manyTaps(2));
    playPerfectly(engine, () => engine.getState().lap >= 1);
    throughBreak(engine);
    const tile = must(nextBeat(engine)[0]);
    const y1 = tile.yPos;
    goTo(songTime + 0.1);
    expect(tile.yPos - y1).toBeCloseTo(SPEED * speed(1) * 0.1, 5);
  });

  it('keeps the timing windows the same in seconds, so a perfect is still a perfect', () => {
    const { engine } = setup(manyTaps(2));
    playPerfectly(engine, () => engine.getState().lap >= 2);
    throughBreak(engine);
    const before = engine.getState().score;
    tapAt(engine, nextBeat(engine)[0], PERFECT_WINDOW - 0.01);
    expect(engine.getState().score - before).toBeGreaterThanOrEqual(POINTS.perfect);
  });

  describe('the break between laps', () => {
    const arrangement: Arrangement = {
      rowsPerBar: 4,
      chords: ['C', 'G'],
      groove: { kick: 'x...', snare: '..x.', hat: 'xoxo', bass: '1...', chord: '.x..', pad: false },
    };

    it('empties the board once a lap is done, and puts the next lap first tile where the timeline says', () => {
      const { engine, timeline } = setup(manyTaps(8), { arrangement });
      playPerfectly(engine, () => engine.getState().lap >= 1);
      expect(nextBeat(engine)).toEqual([]); // nothing to aim at through the rest
      throughBreak(engine);
      const [first] = nextBeat(engine);
      expect(first.beat).toBe(8);
      expect(first.time).toBeCloseTo(timeline.lapStart(1), 9);
      goTo(first.time);
      expect(centre(first)).toBeCloseTo(BAR_Y, 6);
      const before = engine.getState().score;
      engine.press(first.lane, 'p1');
      expect(engine.getState().score - before).toBeGreaterThanOrEqual(POINTS.perfect);
    });

    it('names the new lap and its speed as soon as the break begins, and resets the progress bar', () => {
      const { engine } = setup(manyTaps(8), { arrangement });
      playPerfectly(engine, () => engine.getState().lap >= 1);
      expect(engine.getState()).toMatchObject({ lap: 1, speedMultiplier: speed(1), progress: 0 });
      throughBreak(engine);
      tapAt(engine, nextBeat(engine)[0], 0);
      tapAt(engine, nextBeat(engine)[0], 0);
      expect(engine.getState().progress).toBeCloseTo(1 / 8, 2);
    });

    it('plays no music through the rest, then counts in one soft tick a beat, ending a beat before the first tile', () => {
      const { engine, scheduled, timeline, song } = setup(manyTaps(8), { arrangement });
      playPerfectly(engine, () => engine.getState().lap >= 1);
      const before = scheduled.length;
      goTo(timeline.lapStart(1) - 0.2);
      const breakEvents = scheduled.slice(before).filter((s) => s.at < timeline.lapStart(1) - 1e-9);
      const beat = song.rowsPerBeat / timeline.rate(1);

      expect(breakEvents.map((s) => s.event.kind).sort()).toEqual(['hat', 'hat', 'hat', 'hat', 'kick']);
      breakEvents.sort((a, b) => a.at - b.at);
      const times = breakEvents.filter((s) => s.event.kind !== 'kick').map((s) => s.at);
      expect(breakEvents[0].event.kind).toBe('kick');
      expect(breakEvents[0].at).toBeCloseTo(timeline.lapStart(1) - COUNT_IN_BEATS * beat, 9);
      // Ticks land a beat apart, the last one a beat ahead of the first tile.
      expect(times[times.length - 1]).toBeCloseTo(timeline.lapStart(1) - beat, 9);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(beat, 9);
      // The first tick comes only after the rest (which is at least LAP_REST_SECONDS long).
      expect(breakEvents[0].at - timeline.lapEnd(0)).toBeGreaterThanOrEqual(LAP_REST_SECONDS - 1e-9);
    });

    it('shows the count-in numbers on each beat, and only once each', () => {
      const counts: string[] = [];
      const effects: Fx = { ...noopFx, count: (text) => counts.push(text) };
      const { engine, timeline, song } = setup(manyTaps(8), { effects });
      playPerfectly(engine, () => engine.getState().lap >= 1);
      counts.length = 0; // (the first lap's own count-in went by in a jump, and showed only its last number)
      const beat = song.rowsPerBeat / timeline.rate(1);
      runTo(timeline.lapStart(1) - COUNT_IN_BEATS * beat - 0.05);
      expect(counts).toEqual([]);
      runTo(timeline.lapStart(1) - COUNT_IN_BEATS * beat + 0.05);
      expect(counts).toEqual(['4']);
      runTo(timeline.lapStart(1) - COUNT_IN_BEATS * beat + 0.1);
      expect(counts).toEqual(['4']);
      runTo(timeline.lapStart(1) - beat + 0.05);
      expect(counts).toEqual(['4', '3', '2', '1']);
    });

    it('counts in every later lap of a recorded song too, though its band is the recording', () => {
      const recording: Recording = { url: 'songs/demo/audio.mp3', offset: 0.13, duration: 4.2 };
      const { engine, scheduled, timeline } = setup(manyTaps(8), { recording });
      playPerfectly(engine, () => engine.getState().lap >= 2);
      goTo(timeline.lapStart(2) - 0.2);
      const lap2 = scheduled.filter((s) => s.at > timeline.lapEnd(1) && s.at < timeline.lapStart(2));
      expect(lap2.map((s) => s.event.kind).sort()).toEqual(['hat', 'hat', 'hat', 'hat', 'kick']);
    });

    it('does not punish a tap in the rest, since there is nothing to tap', () => {
      const { engine, timeline } = setup(manyTaps(4));
      playPerfectly(engine, () => engine.getState().lap >= 1);
      const score = engine.getState().score;
      goTo(timeline.lapEnd(0) + 0.5);
      for (let lane = 0; lane < 4; lane++) engine.press(lane, `p${lane}`);
      expect(engine.getState().status).toBe('playing');
      expect(engine.getState().score).toBe(score);
    });

    it('lets the rest run on through the break without a miss, then ends the game if the first tile is ignored', () => {
      const { engine, timeline } = setup(manyTaps(4));
      playPerfectly(engine, () => engine.getState().lap >= 1);
      goTo(timeline.lapStart(1) - 0.1);
      expect(engine.getState().status).toBe('playing');
      goTo(timeline.lapStart(1) + OK_WINDOW + 0.05);
      expect(engine.getState().status).toBe('gameover');
    });

    it('does not lay out the next lap early: the board is empty through the rest', () => {
      const { engine, timeline } = setup(manyTaps(4));
      playPerfectly(engine, () => engine.getState().lap >= 1);
      goTo(timeline.lapEnd(0) + 0.3);
      expect(engine.getTiles().filter((t) => !t.isHit)).toEqual([]);
    });
  });

  it('reports laps in the final stats and saves the best lap count', () => {
    const { engine, results } = setup(manyTaps(8));
    playPerfectly(engine, () => engine.getState().lap >= 2);
    stepUntilOver(engine);
    expect(engine.getState().status).toBe('gameover');
    expect(results[0].stats.laps).toBe(2);
  });
});

describe('progress, pausing and quitting', () => {
  it('tracks how far through the lap the song is', () => {
    const { engine } = setup(manyTaps(4));
    tapAt(engine, firstTile(engine), 0);
    expect(engine.getState().progress).toBeCloseTo(0, 2);
    tapAt(engine, nextBeat(engine)[0], 0);
    expect(engine.getState().progress).toBeCloseTo(0.25, 2);
    tapAt(engine, nextBeat(engine)[0], 0);
    expect(engine.getState().progress).toBeCloseTo(0.5, 2);
  });

  it('freezes the game while paused: no presses count and nothing is missed', () => {
    const { engine, calls } = setup([tap(), tap()]);
    const tile = firstTile(engine);
    goTo(tile.time);
    engine.pause();
    expect(engine.getState().paused).toBe(true);
    expect(calls.suspended).toBe(1);
    engine.press(tile.lane, 'p1');
    expect(engine.getState().score).toBe(0);
    goTo(tile.time + 5); // even if the clock kept going, a paused game does not fail
    expect(engine.getState().status).toBe('playing');

    engine.resume();
    expect(engine.getState().paused).toBe(false);
    expect(calls.resumed).toBe(1);
    expect(calls.silenced).toBe(1); // what was lined up before the pause is dropped; it is scheduled again after the count-in
  });

  it('goes back to the menu and silences the song', () => {
    const { engine, calls } = setup([tap(), tap()]);
    tapAt(engine, firstTile(engine), 0);
    engine.quit();
    expect(engine.getState()).toMatchObject({ status: 'menu', score: 0, combo: 0, lap: 0, paused: false });
    expect(engine.getTiles()).toHaveLength(0);
    expect(calls.stopped).toBeGreaterThanOrEqual(1);
  });

  it('starts cleanly again after a game over', () => {
    const { engine, song, rate } = setup([tap(), tap()]);
    goTo(START + 10); // miss
    expect(engine.getState().status).toBe('gameover');
    songTime = 500;
    engine.start(song);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, combo: 0, lap: 0 });
    const t0 = 500 + (COUNT_IN_BEATS * song.rowsPerBeat) / rate;
    goTo(t0 - IN_VIEW_ROWS / rate); // (the count-in comes first: the board is empty until the tile nears the top)
    expect(firstTile(engine).time).toBeCloseTo(t0, 9);
  });
});

describe('counting in, on the way in and after a pause', () => {
  const arrangement: Arrangement = {
    rowsPerBar: 4,
    chords: ['C', 'G'],
    groove: { kick: 'x...', snare: '..x.', hat: 'xoxo', bass: '1...', chord: '.x..', pad: false },
  };
  // Row k plays a note of its own (300 + k), so a row's melody note can be picked out by pitch.
  const notes = () => Array.from({ length: 8 }, (_, i) => tap(300 + i));
  const kinds = (list: Scheduled[]) => list.map((s) => s.event.kind);
  const melody = (list: Scheduled[], freq: number) =>
    list.find((s) => s.event.kind === 'melody' && (s.event as { freq: number }).freq === freq);

  /** At this speed a beat (two rows) is a second, and the first tile is due at `t0`, four beats in. */
  function counted(options: SetupOptions = {}) {
    const counts: string[] = [];
    const effects: Fx = { ...noopFx, count: (text) => counts.push(text) };
    const made = setup(notes(), { arrangement, effects, ...options });
    return { ...made, counts };
  }

  /**
   * Clear the first three tiles on the bar (rows 0, 1 and 2, due at t0, t0 + 0.5 and t0 + 1), then
   * pause `after` seconds past row 2. The next tile is row 3, due at t0 + 1.5; the song's next beat
   * is row 4, at t0 + 2.
   */
  function pausedAfterThree(after: number, options: SetupOptions = {}) {
    const made = counted(options);
    for (let i = 0; i < 3; i++) tapAt(made.engine, must(nextBeat(made.engine)[0]), 0);
    goTo(made.t0 + 1 + after);
    made.engine.pause();
    made.counts.length = 0;
    return made;
  }

  it('counts the first lap in with the numbers 4 3 2 1, one on each beat, the 1 a beat before the first tile', () => {
    const { t0, rate, song, counts } = counted({ onBoard: false });
    const beat = song.rowsPerBeat / rate;
    const shown: { text: string; at: number }[] = [];
    while (songTime < t0 - 0.01) {
      step();
      while (shown.length < counts.length) shown.push({ text: counts[shown.length], at: songTime });
    }
    expect(shown.map((s) => s.text)).toEqual(['4', '3', '2', '1']);
    // Each number appears on its beat (within a frame), and the last one is a beat before the first tile.
    shown.forEach((s, i) => {
      expect(s.at - (START + i * beat)).toBeGreaterThanOrEqual(-1e-6);
      expect(s.at - (START + i * beat)).toBeLessThan(1 / 60 + 1e-6);
    });
    expect(t0 - beat - shown[3].at).toBeLessThan(1 / 60 + 1e-6);
  });

  describe('after a pause', () => {
    it('plays four ticks, a beat apart, and silences what was scheduled before the pause', () => {
      const { engine, scheduled, calls, rate, song } = pausedAfterThree(0.1);
      const beat = song.rowsPerBeat / rate;
      songTime = 200;
      const before = scheduled.length;
      engine.resume();
      const ticks = scheduled.slice(before);

      expect(calls.silenced).toBe(1);
      expect(kinds(ticks)).toEqual(['kick', 'hat', 'hat', 'hat', 'hat']);
      const start = ticks[0].at;
      // (A moment for the audio clock to catch up, and more than the longest delay to the speaker that is made up for
      // (a quarter of a second): the song clock is that far behind the audio context's, and a tick handed over for a time
      // that has already gone by on the context's would come late.)
      expect(start - 200).toBeGreaterThan(0.25);
      expect(start - 200).toBeLessThan(0.5);
      ticks.forEach((tick, i) => expect(tick.at).toBeCloseTo(start + Math.max(0, i - 1) * beat, 9));
      for (const tick of ticks) expect(tick.secondsPerRow).toBeCloseTo(1 / rate, 9);
    });

    it("lands the last tick a beat before the song's next beat, and picks the music up there", () => {
      const { engine, scheduled, rate, song } = pausedAfterThree(0.1);
      const beat = song.rowsPerBeat / rate;
      songTime = 200;
      const before = scheduled.length;
      engine.resume();
      const lastTick = scheduled[scheduled.length - 1].at;
      runTo(204);
      const after = scheduled.slice(before);

      expect(melody(after, 304)?.at).toBeCloseTo(lastTick + beat, 9); // row 4, the next beat
      expect(must(melody(after, 303)).at).toBeGreaterThan(lastTick); // row 3, on the way there
      expect(melody(after, 302)).toBeUndefined(); // row 2 had already gone by
      for (const note of after.filter((s) => s.event.kind === 'melody')) expect(note.at).toBeGreaterThan(lastTick);
    });

    it('waits nothing extra when the pause fell exactly on a beat: that beat is the one after the count', () => {
      const { engine, scheduled, rate, song } = pausedAfterThree(0);
      const beat = song.rowsPerBeat / rate;
      songTime = 200;
      const before = scheduled.length;
      engine.resume();
      const lastTick = scheduled[scheduled.length - 1].at;
      runTo(203.4); // (the next tile is not due until 0.5s of song after the count, so nothing is missed yet)
      expect(melody(scheduled.slice(before), 302)?.at).toBeCloseTo(lastTick + beat, 9); // row 2
    });

    it('holds the song still through the count, ignoring taps, then carries on from the same place on time', () => {
      const { engine, t0 } = pausedAfterThree(0.1);
      const tile = must(nextBeat(engine)[0]);
      const y = tile.yPos;
      songTime = 200;
      engine.resume();
      runTo(203.45); // the count-in is nearly over (the song moves again at 203.5)

      expect(tile.yPos).toBeCloseTo(y, 9);
      expect(tile.time).toBeCloseTo(t0 + 1.5, 9);
      const score = engine.getState().score;
      engine.press(tile.lane, 'p9');
      engine.press((tile.lane + 1) % 4, 'p8'); // not even a wrong lane counts
      expect(engine.getState()).toMatchObject({ status: 'playing', score });

      goTo(203.9); // 0.4s of song after the count: row 3 is on the bar
      expect(centre(tile)).toBeCloseTo(BAR_Y, 6);
      engine.press(tile.lane, 'p1');
      expect(engine.getState().score - score).toBeGreaterThanOrEqual(POINTS.perfect);
    });

    it('shows 4 3 2 1 as each tick sounds, once each', () => {
      const { engine, counts } = pausedAfterThree(0.1);
      songTime = 200;
      engine.resume();
      runTo(200.35);
      expect(counts).toEqual([]);
      runTo(200.55);
      expect(counts).toEqual(['4']);
      runTo(201.55);
      expect(counts).toEqual(['4', '3']);
      runTo(203.55);
      expect(counts).toEqual(['4', '3', '2', '1']);
      runTo(203.75);
      expect(counts).toEqual(['4', '3', '2', '1']);
    });

    it('plays the whole count-in again when paused during it, and still lands on the beat', () => {
      const { engine, counts, scheduled } = pausedAfterThree(0.1);
      songTime = 200;
      engine.resume();
      runTo(201.55);
      expect(counts).toEqual(['4', '3']);
      engine.pause();
      songTime = 300;
      const before = scheduled.length;
      engine.resume();

      expect(kinds(scheduled.slice(before))).toEqual(['kick', 'hat', 'hat', 'hat', 'hat']);
      counts.length = 0;
      runTo(303.55);
      expect(counts).toEqual(['4', '3', '2', '1']);
      const tile = must(nextBeat(engine)[0]);
      goTo(303.9); // the song had not moved: 0.4s past the count is row 3 again
      expect(centre(tile)).toBeCloseTo(BAR_Y, 6);
    });

    it('adds no count-in when paused in the lead-in with its last tick still to come', () => {
      const { engine, scheduled, t0, counts } = counted({ onBoard: false });
      runTo(START + 1.5);
      expect(counts).toEqual(['4', '3']);
      const frozen = songTime;
      engine.pause();
      songTime = 500;
      const shift = 500 - frozen;
      const before = scheduled.length;
      engine.resume();
      expect(scheduled.length).toBe(before); // nothing extra is played

      runTo(t0 + shift - 0.3);
      expect(counts).toEqual(['4', '3', '2', '1']);
      const rest = scheduled.slice(before).filter((s) => s.at < t0 + shift - 1e-9);
      expect(kinds(rest)).toEqual(['hat', 'hat']); // the two ticks the lead-in had left, on their own beats
      expect(rest.map((s) => s.at)).toEqual([expect.closeTo(START + 2 + shift, 9), expect.closeTo(START + 3 + shift, 9)]);
      expect(engine.getState().status).toBe('playing');
    });

    it("adds no count-in when paused in the rest between laps, and the lap's own count-in carries on", () => {
      const { engine, scheduled, timeline, counts } = counted();
      playPerfectly(engine, () => engine.getState().lap >= 1);
      goTo(timeline.lapEnd(0) + 0.3);
      counts.length = 0;
      const frozen = songTime;
      engine.pause();
      songTime = 900;
      const shift = 900 - frozen;
      const before = scheduled.length;
      engine.resume();
      expect(scheduled.length).toBe(before);

      runTo(timeline.lapStart(1) + shift - 0.1);
      expect(counts).toEqual(['4', '3', '2', '1']);
      expect(engine.getState().status).toBe('playing');
    });

    it('hands a recorded song back, held until the count is over, and with its cut', () => {
      const recording: Recording = { url: 'songs/demo/audio.mp3', offset: 0.13, duration: 4.2, end: 3.5 };
      const { engine, played, t0 } = pausedAfterThree(0.1, { recording });
      expect(played).toHaveLength(1);
      songTime = 200;
      engine.resume();
      runTo(200.1);

      expect(played).toHaveLength(2);
      const again = played[1];
      expect(again).toMatchObject({ url: recording.url, rate: 1, end: 3.5 });
      expect(again.notBefore).toBeCloseTo(203.5, 6); // where the song moves again
      // It is timed so the recording's beat grid lands where the rows will: 0.13s before row 0.
      expect(again.at).toBeCloseTo(t0 - 0.13 + (203.5 - (t0 + 1.1)), 6);
    });
  });
});

describe('continuing a failed run', () => {
  /** What the effects were told, so the count-in numbers and the banner can be read off. */
  function watched(options: SetupOptions & { beats?: BeatSpec[] } = {}) {
    const counts: string[] = [];
    const banners: string[] = [];
    const effects: Fx = { ...noopFx, count: (text) => counts.push(text), banner: (title) => banners.push(title) };
    // (Sixteen taps a lap, a row each, in two bars of eight rows: the ninth tap starts the second bar.)
    const { beats = manyTaps(16), ...rest } = options;
    return { ...setup(beats, { effects, ...rest }), counts, banners };
  }

  /** Where the run has got to: the beat of the lowest tile not yet cleared. */
  const beatNow = (engine: GameEngine): number => nextBeat(engine)[0]?.beat ?? -1;

  /** Clear tiles perfectly until the next one is on `beat`, then let that one go by: the run fails on it. */
  function fallOn(made: ReturnType<typeof watched>, beat: number): void {
    playPerfectly(made.engine, () => beatNow(made.engine) >= beat);
    stepUntilOver(made.engine);
    expect(made.engine.getState().status).toBe('gameover');
  }

  const plays = () => loadStats().test?.plays ?? 0;

  describe('the offer', () => {
    it('comes with the first fall of a run that has scored, at a quarter off, and saves nothing yet', () => {
      const made = watched();
      fallOn(made, 2);
      const { engine, results } = made;
      const score = engine.getState().score;
      expect(score).toBeGreaterThan(0);
      expect(engine.canContinue()).toBe(true);
      expect(results).toEqual([expect.objectContaining({ score, isNewBest: false, reason: 'miss', continueScore: continueScore(score) })]);
      expect(continueScore(score)).toBe(Math.round(score * 0.75));
      expect(getBest('test')).toBe(0);
      expect(plays()).toBe(0);
    });

    it('is not made to a run that has not scored: there is nothing to keep', () => {
      const made = watched();
      goTo(firstTile(made.engine).time + 5);
      expect(made.engine.getState().status).toBe('gameover');
      expect(made.engine.canContinue()).toBe(false);
      expect(made.results).toEqual([expect.objectContaining({ score: 0, continueScore: null })]);
      expect(plays()).toBe(1);
    });

    it('takes a share of the score and leaves the rest', () => {
      expect(continueScore(0)).toBe(0);
      expect(continueScore(400)).toBe(300);
      expect(continueScore(101)).toBe(76);
    });

    it('is turned down with finish, which saves the run once and tells how it went', () => {
      const made = watched();
      fallOn(made, 3);
      const { engine, results } = made;
      const score = engine.getState().score;
      engine.finish();
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({ score, isNewBest: true, reason: 'miss', continueScore: null });
      expect(results[1].stats.maxChain).toBe(3);
      expect(getBest('test')).toBe(score);
      expect(engine.getState()).toMatchObject({ status: 'gameover', score, highScore: score });
      expect(engine.canContinue()).toBe(false);

      engine.finish();
      engine.continueRun();
      expect(results).toHaveLength(2);
      expect(plays()).toBe(1);
      expect(engine.getState().status).toBe('gameover');
    });

    it('does nothing while the game is being played', () => {
      const { engine, calls, results } = watched();
      const started = calls.started;
      engine.finish();
      engine.continueRun();
      expect(engine.getState().status).toBe('playing');
      expect(calls.started).toBe(started);
      expect(results).toHaveLength(0);
      expect(plays()).toBe(0);
    });

    it('is saved after all when the player leaves it unanswered, by quitting or starting over', () => {
      const quitting = watched();
      fallOn(quitting, 3);
      const score = quitting.engine.getState().score;
      quitting.engine.quit();
      expect(getBest('test')).toBe(score);
      expect(plays()).toBe(1);
      quitting.engine.quit();
      expect(plays()).toBe(1);

      const again = watched();
      fallOn(again, 2);
      songTime = 900;
      again.engine.start(again.song);
      expect(plays()).toBe(2);
      expect(again.engine.canContinue()).toBe(false);
    });
  });

  describe('carrying on', () => {
    it('goes back into the bar it fell in, through a count-in: score cut, chain gone, best chain kept', () => {
      const made = watched();
      fallOn(made, 10); // (the tenth tap is in the second bar, which starts at row 8)
      const { engine, timeline, scheduled, counts, banners, results } = made;
      const before = engine.getState();
      expect(before.comboMultiplier).toBe(1); // (a fall breaks the chain, and the offer says so)
      const score = before.score;
      expect(score).toBeGreaterThan(0);

      songTime = 300;
      counts.length = 0;
      const heard = scheduled.length;
      engine.continueRun();

      expect(engine.getState()).toMatchObject({
        status: 'playing', score: continueScore(score), combo: 0, comboMultiplier: 1, lap: 0, paused: false,
      });
      expect(engine.canContinue()).toBe(false);
      expect(banners).toContain('Second chance');
      // The bar's own tiles are laid out again, from its first tap, and the ones before it were played: they are not on the board.
      expect(firstTile(engine).beat).toBe(8);
      expect(firstTile(engine).time).toBeCloseTo(timeline.arrival(0, 8), 9);
      expect(engine.getTiles().every((tile) => !tile.isHit)).toBe(true);
      // Nothing is saved by continuing: the run is not over.
      expect(results).toHaveLength(1);
      expect(plays()).toBe(0);

      // Four ticks a beat apart lead the way, the first of them a moment after the click, and the numbers show as they sound.
      const ticks = scheduled.slice(heard);
      expect(ticks.map((s) => s.event.kind)).toEqual(['kick', 'hat', 'hat', 'hat', 'hat']);
      ticks.forEach((tick, i) => expect(tick.at).toBeCloseTo(300.4 + Math.max(0, i - 1), 9));
      runTo(303.5);
      expect(counts).toEqual(['4', '3', '2', '1']);
      runTo(304.6);
      expect(counts).toEqual(['4', '3', '2', '1']); // (and not again as the song's own count-in numbers would come)

      // The chain starts from ×1 again: the first perfect is worth what a perfect is worth, no more.
      const tile = firstTile(engine);
      goTo(305.4);
      expect(centre(tile)).toBeCloseTo(BAR_Y, 6);
      engine.press(tile.lane, 'p1');
      expect(engine.getState().score).toBe(continueScore(score) + POINTS.perfect);
      expect(engine.getState().comboMultiplier).toBe(1);
    });

    it('holds the song still through the count, and ignores taps until it is over', () => {
      const made = watched();
      fallOn(made, 10);
      const { engine } = made;
      songTime = 300;
      engine.continueRun();
      const tile = firstTile(engine);
      const y = tile.yPos;
      const score = engine.getState().score;
      runTo(304.3); // (the song moves again at 304.4)
      expect(tile.yPos).toBeCloseTo(y, 9);
      engine.press(tile.lane, 'p9');
      engine.press((tile.lane + 1) % 4, 'p8'); // not even a wrong lane counts
      expect(engine.getState()).toMatchObject({ status: 'playing', score });
      runTo(304.9);
      expect(tile.yPos).toBeGreaterThan(y);
    });

    it("goes back to the start of a lap through the lap's own count-in when it fell in the first bar", () => {
      const made = watched();
      fallOn(made, 2);
      const { engine, timeline, scheduled, counts } = made;
      const score = engine.getState().score;
      songTime = 300;
      counts.length = 0;
      const heard = scheduled.length;
      engine.continueRun();
      expect(engine.getState()).toMatchObject({ status: 'playing', score: continueScore(score), combo: 0, comboMultiplier: 1 });
      expect(engine.getTiles()).toHaveLength(0); // (the board stays empty through the count-in, as it does at the start)

      runTo(304);
      expect(firstTile(engine).beat).toBe(0);
      expect(firstTile(engine).time).toBeCloseTo(timeline.arrival(0, 0), 9);
      const ticks = scheduled.slice(heard).filter((s) => s.event.kind === 'kick' || s.event.kind === 'hat');
      expect(ticks.map((s) => s.event.kind).slice(0, 5)).toEqual(['kick', 'hat', 'hat', 'hat', 'hat']);
      ticks.slice(0, 5).forEach((tick, i) => expect(tick.at).toBeCloseTo(300.4 + Math.max(0, i - 1), 9));
      expect(counts).toEqual(['4', '3', '2', '1']);

      const tile = firstTile(engine);
      goTo(304.4); // (the first tile, four beats of count-in after the song moves again)
      expect(centre(tile)).toBeCloseTo(BAR_Y, 6);
      engine.press(tile.lane, 'p1');
      expect(engine.getState().score).toBe(continueScore(score) + POINTS.perfect);
    });

    it("carries on in the lap it fell in, at that lap's speed", () => {
      const made = watched();
      playPerfectly(made.engine, () => made.engine.getState().lap >= 1);
      throughBreak(made.engine);
      fallOn(made, 16 + 10);
      const { engine, timeline } = made;
      expect(engine.getState().lap).toBe(1);
      const score = engine.getState().score;
      songTime = 900;
      engine.continueRun();
      expect(engine.getState()).toMatchObject({ status: 'playing', score: continueScore(score), lap: 1 });
      expect(engine.getState().speedMultiplier).toBeCloseTo(speed(1), 2);
      expect(firstTile(engine).beat).toBe(16 + 8);
      expect(firstTile(engine).time).toBeCloseTo(timeline.arrival(1, 8), 9);
      runTo(903.5); // (still counting in: nothing is due until 904.6, a beat after the song moves again at 903.7)
      expect(engine.getState().status).toBe('playing');
    });

    it('is only possible once: the next fall ends the run, and saves it', () => {
      const made = watched();
      fallOn(made, 10);
      const { engine, results } = made;
      songTime = 300;
      engine.continueRun();
      const taxed = engine.getState().score;
      stepUntilOver(engine, 1200);
      expect(engine.getState().status).toBe('gameover');
      expect(engine.canContinue()).toBe(false);
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({ score: taxed, continueScore: null, reason: 'miss' });
      expect(results[1].stats.maxChain).toBe(10); // (the chain reached before the fall still counts)
      expect(getBest('test')).toBe(taxed);
      expect(plays()).toBe(1);
      engine.continueRun();
      expect(engine.getState().status).toBe('gameover');
    });

    it('is possible again in a new run', () => {
      const made = watched();
      fallOn(made, 10);
      songTime = 300;
      made.engine.continueRun();
      stepUntilOver(made.engine, 1200);
      expect(made.engine.canContinue()).toBe(false);

      songTime = 2000;
      made.engine.start(made.song);
      goTo(2002.5); // (the first tap is due at 2004)
      fallOn(made, 2);
      expect(made.engine.canContinue()).toBe(true);
    });

    it('hands a recorded song back held until the count is over, and lined up with the rows', () => {
      const recording: Recording = { url: 'songs/demo/audio.mp3', offset: 0.13, duration: 4.2, end: 3.5 };
      const made = watched({ recording });
      fallOn(made, 10);
      const { engine, played, timeline } = made;
      expect(played).toHaveLength(1);
      songTime = 300;
      engine.continueRun();
      runTo(300.1);

      expect(played).toHaveLength(2);
      expect(played[1]).toMatchObject({ url: recording.url, rate: 1, end: 3.5 });
      expect(played[1].notBefore).toBeCloseTo(304.4, 6); // where the song moves again
      // Row 6 (the beat before the bar) is on the clock where the song was held, so the recording is timed to row 0 from there.
      expect(played[1].at).toBeCloseTo(timeline.lapStart(0) - 0.13 + (304.4 - timeline.arrival(0, 6)), 6);
    });
  });
});
