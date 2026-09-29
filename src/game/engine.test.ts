import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAR_Y,
  COMBO_MAX_MULTIPLIER,
  COMBO_STEP,
  GOOD_WINDOW,
  HOLD_TICK_POINTS,
  LAP_SPEED_FACTOR,
  LEAD_ROWS,
  OK_WINDOW,
  PERFECT_WINDOW,
  POINTS,
  TILE_HEIGHT,
} from '../config';
import { buildTrack, type Arrangement } from '../songs/arrangement';
import type { BeatSpec, GameState, MusicEvent, Recording, Song, Tile } from '../types';
import type { Sound } from './audio';
import { noopFx } from './effects';
import { comboMultiplier, GameEngine, judge, type GameOverResult } from './engine';
import { getBest } from './storage';

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
interface Played { url: string; at: number; rate: number }

interface SetupOptions { speed?: number; arrangement?: Arrangement; recording?: Recording }

function setup(beats: BeatSpec[], { speed = SPEED, arrangement, recording }: SetupOptions = {}) {
  const scheduled: Scheduled[] = [];
  const played: Played[] = [];
  const calls = { started: 0, stopped: 0, suspended: 0, resumed: 0, levelUps: 0, errors: 0 };
  const states: GameState[] = [];
  const results: GameOverResult[] = [];
  const audio: Sound = {
    unlock() {},
    now: () => songTime,
    startSong: () => { calls.started++; },
    stopSong: () => { calls.stopped++; },
    schedule: (event, at, secondsPerRow) => { scheduled.push({ event, at, secondsPerRow }); },
    load: async () => {},
    playRecording: (url, at, rate) => { played.push({ url, at, rate }); },
    suspend: () => { calls.suspended++; },
    resume: () => { calls.resumed++; },
    playError: () => { calls.errors++; },
    playLevelUp: () => { calls.levelUps++; },
  };
  const engine = new GameEngine({
    layer: document.createElement('div'),
    audio,
    effects: noopFx,
    onStateChange: (state) => states.push(state),
    onGameOver: (result) => results.push(result),
  });
  songTime = START;
  const song = makeSong(beats, speed, arrangement, recording);
  engine.start(song);
  const rate = speed / TILE_HEIGHT; // rows per second on lap 0
  return { engine, song, scheduled, played, calls, states, results, rate, t0: START + LEAD_ROWS / rate };
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
      step();
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

  it('adds a multiplier for every COMBO_STEP perfects, up to a cap', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(COMBO_STEP - 1)).toBe(1);
    expect(comboMultiplier(COMBO_STEP)).toBe(2);
    expect(comboMultiplier(COMBO_STEP * 3)).toBe(4);
    expect(comboMultiplier(10_000)).toBe(COMBO_MAX_MULTIPLIER);
  });
});

describe('the song clock', () => {
  it('starts with an empty board and a lead-in before the first tile', () => {
    const { engine, calls, t0 } = setup([tap(), tap()]);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, lap: 0, speedMultiplier: 1 });
    expect(calls.started).toBe(1);
    const tile = firstTile(engine);
    expect(tile.time).toBeCloseTo(t0, 9);
    expect(tile.yPos + TILE_HEIGHT).toBeLessThanOrEqual(0); // still above the top of the board
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

  it('counts the player in with soft ticks before the first tile arrives', () => {
    const { scheduled, t0 } = setup(eight(), { arrangement });
    goTo(t0 - 0.4);
    const early = scheduled.filter((s) => s.at < t0 - 1e-9);
    expect(early.map((s) => s.event.kind).sort()).toEqual(['hat', 'hat', 'hat', 'hat', 'kick']);
    expect(early.map((s) => s.at).sort()).toEqual([...early.map((s) => s.at)].sort());
    expect(Math.min(...early.map((s) => s.at))).toBeCloseTo(START, 9);
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
    goTo(songTime + 0.3);
    const last = scheduled[scheduled.length - 1];
    expect(last.secondsPerRow).toBeCloseTo(1 / (rate * LAP_SPEED_FACTOR), 9);
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
    expect(played).toEqual([{ url: recording.url, at: t0 - 0.13, rate: 1 }]);
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
    const { engine, played, rate } = setup(eight(), { recording });
    const due = new Map<number, number>(); // beat -> when its tile is due (tiles are removed once cleared)
    playPerfectly(engine, () => {
      for (const tile of engine.getTiles()) due.set(tile.beat, tile.time);
      return engine.getState().lap >= 2;
    });
    goTo(songTime + 0.2);
    expect(played.map((p) => p.rate)).toEqual([1, LAP_SPEED_FACTOR, LAP_SPEED_FACTOR ** 2]);

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
    [-0.06, 'perfect', POINTS.perfect],
    [-0.12, 'good', POINTS.good],
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

  it('ignores a press before the next tile is even on screen', () => {
    const { engine } = setup([tap(), tap()]);
    engine.press(firstTile(engine).lane, 'p1');
    engine.press((firstTile(engine).lane + 1) % 4, 'p1');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0 });
  });

  it('counts each judgment in the final stats', () => {
    const { engine, results } = setup([tap(), tap(), tap(), tap()]);
    tapAt(engine, firstTile(engine), 0); // perfect
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 1)), 0.1); // good
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

  it('are broken by any hit that is not perfect', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP + 1);
    expect(engine.getState().comboMultiplier).toBe(2);
    const scoreBefore = engine.getState().score;

    tapAt(engine, nextBeat(engine)[0], 0.1); // merely good
    expect(engine.getState()).toMatchObject({ combo: 0, comboMultiplier: 1 });
    expect(engine.getState().score - scoreBefore).toBe(POINTS.good * 2); // still earned at the old multiplier
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

describe('double tiles', () => {
  it('lay two tiles in one row with exactly one lane between them', () => {
    for (let i = 0; i < 30; i++) {
      const { engine } = setup([double(), double()]);
      const [left, right] = engine.getTiles();
      expect(left.yPos).toBe(right.yPos);
      expect(left.beat).toBe(right.beat);
      expect(left.time).toBe(right.time);
      expect(right.lane - left.lane).toBe(2);
      expect([0, 1]).toContain(left.lane);
      expect([left.freq, right.freq]).toEqual([440, 550]);
    }
  });

  it('need both tiles tapped, each graded on its own, before the beat is cleared', () => {
    const { engine } = setup([double(), tap(), tap()]);
    const [left, right] = engine.getTiles();
    tapAt(engine, right, 0);
    expect(engine.getState().score).toBe(POINTS.perfect);
    expect(nextBeat(engine).map((t) => t.id)).toContain(left.id);

    tapAt(engine, left, 0.1);
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
  it('jumps the speed by a fixed factor each time the song finishes', () => {
    const { engine, calls, states } = setup(manyTaps(4));
    playPerfectly(engine, () => engine.getState().lap >= 3);
    expect(engine.getState().status).toBe('playing');
    const speeds = [0, 1, 2, 3].map((lap) => states.find((s) => s.lap === lap)?.speedMultiplier);
    expect(speeds).toEqual([1, 1.3, 1.69, 2.2]);
    expect(calls.levelUps).toBe(3);
    expect(engine.getState().speedMultiplier).toBe(Math.round(LAP_SPEED_FACTOR ** 3 * 100) / 100);
  });

  it('starts the next lap exactly one song after the first, and plays it faster', () => {
    const { engine, scheduled, t0, rate } = setup(manyTaps(4));
    playPerfectly(engine, () => engine.getState().lap >= 1);
    expect(engine.getState().lap).toBe(1);
    const lap1Start = t0 + 4 / rate;
    goTo(lap1Start + 1);
    const melody = scheduled.filter((s) => s.event.kind === 'melody');
    const lap0Gap = melody[1].at - melody[0].at;
    const lap1 = melody.filter((n) => n.at >= lap1Start - 1e-9);
    expect(lap1[0].at).toBeCloseTo(lap1Start, 9);
    expect(lap1[1].at - lap1[0].at).toBeCloseTo(lap0Gap / LAP_SPEED_FACTOR, 9);
  });

  it('makes tiles fall faster on later laps', () => {
    const { engine } = setup(manyTaps(2));
    playPerfectly(engine, () => engine.getState().lap >= 1);
    const tile = must(nextBeat(engine)[0]);
    const y1 = tile.yPos;
    goTo(songTime + 0.1);
    expect(tile.yPos - y1).toBeCloseTo(SPEED * LAP_SPEED_FACTOR * 0.1, 5);
  });

  it('keeps the timing windows the same in seconds, so a perfect is still a perfect', () => {
    const { engine } = setup(manyTaps(2));
    playPerfectly(engine, () => engine.getState().lap >= 2);
    const before = engine.getState().score;
    tapAt(engine, nextBeat(engine)[0], PERFECT_WINDOW - 0.01);
    expect(engine.getState().score - before).toBeGreaterThanOrEqual(POINTS.perfect);
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
    expect(firstTile(engine).time).toBeCloseTo(500 + LEAD_ROWS / rate, 9);
  });
});
