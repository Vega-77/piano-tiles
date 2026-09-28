import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAR_Y,
  COMBO_MAX_MULTIPLIER,
  COMBO_STEP,
  GOOD_WINDOW,
  HOLD_BONUS,
  HOLD_RELEASE_TOLERANCE,
  LAP_SPEED_FACTOR,
  LEAD_ROWS,
  MISS_AFTER,
  PERFECT_WINDOW,
  POINTS,
  TILE_HEIGHT,
} from '../config';
import type { BeatSpec, GameState, Song, Tile } from '../types';
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
const RATE = SPEED / TILE_HEIGHT;
const START = 100; // song time when the game starts
const T0 = START + LEAD_ROWS / RATE; // song time when the first tile reaches the bar

const tap = (freq = 440): BeatSpec => ({ type: 'tap', freq });
const double = (): BeatSpec => ({ type: 'double', freqs: [440, 550] });
const hold = (rows: number): BeatSpec => ({ type: 'hold', freq: 330, rows });
/** A realistic-length song. (A one-beat song would have a one-row lap, and laps shrink geometrically.) */
const manyTaps = (count: number): BeatSpec[] => Array.from({ length: count }, () => tap());

function makeSong(beats: BeatSpec[]): Song {
  return {
    id: 'test', title: 'Test', composer: 'Tester', description: '', difficulty: 1,
    speed: SPEED, hue: 200, hue2: 250, beats,
  };
}

interface Scheduled { freq: number; at: number; hold?: number }

function setup(beats: BeatSpec[]) {
  const scheduled: Scheduled[] = [];
  const calls = { started: 0, stopped: 0, suspended: 0, resumed: 0, levelUps: 0, errors: 0 };
  const states: GameState[] = [];
  const results: GameOverResult[] = [];
  const audio: Sound = {
    unlock() {},
    now: () => songTime,
    startSong: () => { calls.started++; },
    stopSong: () => { calls.stopped++; },
    schedule: (freq, at, options) => { scheduled.push({ freq, at, hold: options?.hold }); },
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
  const song = makeSong(beats);
  engine.start(song);
  return { engine, song, scheduled, calls, states, results };
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

/** Move the clock to `offset` seconds after the tile reaches the bar (negative = early), then tap its lane. */
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
  it('grades by distance from the bar in either direction', () => {
    expect(judge(0)).toEqual({ judgment: 'perfect', early: false });
    expect(judge(-(PERFECT_WINDOW - 0.001))).toEqual({ judgment: 'perfect', early: true });
    expect(judge(PERFECT_WINDOW - 0.001).judgment).toBe('perfect');
    expect(judge(PERFECT_WINDOW + 0.001)).toEqual({ judgment: 'good', early: false });
    expect(judge(-(GOOD_WINDOW - 0.001))).toEqual({ judgment: 'good', early: true });
    expect(judge(GOOD_WINDOW + 0.001)).toEqual({ judgment: 'ok', early: false });
    expect(judge(-1)).toEqual({ judgment: 'ok', early: true });
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
    const { engine, calls, scheduled } = setup([tap(), tap()]);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, lap: 0, speedMultiplier: 1 });
    expect(calls.started).toBe(1);
    const tile = firstTile(engine);
    expect(tile.time).toBeCloseTo(T0, 9);
    expect(tile.yPos + TILE_HEIGHT).toBeLessThanOrEqual(0); // still above the top of the board
    expect(scheduled).toEqual([]); // no music until it is nearly time
  });

  it('puts each tile on the bar exactly when it is due', () => {
    const { engine } = setup([tap(), tap(), tap(), tap()]);
    const [first] = engine.getTiles();
    goTo(first.time);
    expect(first.yPos + TILE_HEIGHT).toBeCloseTo(BAR_Y, 6); // leading edge on the bar

    engine.press(first.lane, 'p1'); // (an untapped tile would end the game)
    const second = must(engine.getTiles().find((t) => t.beat === 1));
    expect(second.time - first.time).toBeCloseTo(1 / RATE, 9);
    goTo(second.time);
    expect(second.yPos + TILE_HEIGHT).toBeCloseTo(BAR_Y, 6);
  });

  it('moves tiles at the song speed, on its own, with no taps needed', () => {
    const { engine } = setup([tap(), tap(), tap()]);
    const first = firstTile(engine);
    goTo(T0 - 1);
    const before = first.yPos;
    goTo(T0 - 0.5);
    expect(first.yPos - before).toBeCloseTo(SPEED * 0.5, 6);
  });

  it('keeps enough tiles queued to cover the board plus a row above', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().score > 3000);
    for (let i = 0; i < 20; i++) {
      step(10);
      const tiles = engine.getTiles();
      expect(tiles[tiles.length - 1].yPos).toBeLessThanOrEqual(-TILE_HEIGHT);
      expect(tiles.length).toBeLessThan(12); // scrolled-off tiles are recycled
    }
  });
});

describe('the music', () => {
  it('is scheduled at the moment each tile reaches the bar, whether or not it is tapped', () => {
    const { engine, scheduled } = setup([tap(300), tap(400), tap(500), tap(600)]);
    // Tap the first tile late, the second early, and let the third through.
    tapAt(engine, firstTile(engine), 0.2);
    const second = must(engine.getTiles().find((t) => t.beat === 1));
    tapAt(engine, second, -0.4);
    goTo(T0 + 3 / RATE); // fourth tile due; the third was never tapped but is still scheduled
    const third = must(engine.getTiles().find((t) => t.beat === 2));
    const times = [T0, T0 + 1 / RATE, third.time, T0 + 3 / RATE];
    const freqs = scheduled.slice(0, 4).map((n) => n.freq);
    expect(freqs).toEqual([300, 400, 500, 600]);
    scheduled.slice(0, 4).forEach((note, i) => expect(note.at).toBeCloseTo(times[i], 9));
  });

  it('plays both notes of a double, and sustains a hold for its length', () => {
    const { engine, scheduled } = setup([double(), hold(3), tap()]);
    goTo(T0 + 2 / RATE); // far enough for everything to have been scheduled
    engine.getState();
    const [a, b, c] = scheduled;
    expect([a.freq, b.freq]).toEqual([440, 550]);
    expect(a.at).toBeCloseTo(T0, 9);
    expect(b.at).toBeCloseTo(T0, 9);
    expect(a.hold).toBeUndefined();
    expect(c.freq).toBe(330);
    expect(c.hold).toBeCloseTo(3 / RATE, 9);
  });

  it('is cut off when the game ends', () => {
    const { engine, calls } = setup([tap(), tap()]);
    goTo(T0 - 0.3);
    engine.press((firstTile(engine).lane + 1) % 4, 'p1'); // wrong lane
    expect(engine.getState().status).toBe('gameover');
    expect(calls.stopped).toBeGreaterThanOrEqual(1);
    expect(calls.errors).toBe(1);
  });
});

describe('timing judgments', () => {
  it.each([
    [0, 'perfect', POINTS.perfect],
    [0.06, 'perfect', POINTS.perfect],
    [-0.06, 'perfect', POINTS.perfect],
    [-0.12, 'good', POINTS.good],
    [0.14, 'good', POINTS.good],
    [-0.4, 'ok', POINTS.ok],
    [0.25, 'ok', POINTS.ok],
  ] as const)('a tap %ss from the bar is %s', (offset, judgment, points) => {
    const { engine } = setup([tap(), tap()]);
    tapAt(engine, firstTile(engine), offset);
    expect(engine.getState().score).toBe(points);
    expect(engine.getState().combo).toBe(judgment === 'perfect' ? 1 : 0);
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
    tapAt(engine, must(engine.getTiles().find((t) => t.beat === 2)), -0.3); // ok
    goTo(must(engine.getTiles().find((t) => t.beat === 3)).time + MISS_AFTER + 0.05); // miss the last
    expect(engine.getState().status).toBe('gameover');
    expect(results[0].stats).toMatchObject({ perfect: 1, good: 1, ok: 1, tiles: 3, maxChain: 1 });
    expect(results[0].score).toBe(POINTS.perfect + POINTS.good + POINTS.ok);
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
    // The multiplier rose exactly when the chain hit each step.
    expect(states.find((s) => s.combo === COMBO_STEP)?.comboMultiplier).toBe(2);
    expect(states.find((s) => s.combo === COMBO_STEP - 1)?.comboMultiplier).toBe(1);
  });

  it('are broken by any hit that is not perfect', () => {
    const { engine } = setup(manyTaps(80));
    playPerfectly(engine, () => engine.getState().combo >= COMBO_STEP + 1);
    expect(engine.getState().comboMultiplier).toBe(2);
    const scoreBefore = engine.getState().score;

    const next = nextBeat(engine)[0];
    tapAt(engine, next, 0.1); // merely good
    expect(engine.getState()).toMatchObject({ combo: 0, comboMultiplier: 1 });
    expect(engine.getState().score - scoreBefore).toBe(POINTS.good * 2); // still earned at the old multiplier
    // ...and the next perfect starts a fresh chain at the base value.
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
    expect(results).toEqual([expect.objectContaining({ score: 0, isNewBest: false })]);
  });

  it('a tile left too late is missed, and the board slides back to show it on the bar', () => {
    const { engine, results } = setup([tap(), tap()]);
    const tile = firstTile(engine);
    goTo(tile.time + MISS_AFTER - 0.01);
    expect(engine.getState().status).toBe('playing'); // still hittable
    goTo(tile.time + MISS_AFTER + 0.01);
    expect(engine.getState().status).toBe('gameover');
    expect(tile.yPos + TILE_HEIGHT).toBeCloseTo(BAR_Y, 6);
    expect(results).toHaveLength(1);
  });

  it('saves the run', () => {
    const { engine } = setup([tap(), tap()]);
    tapAt(engine, firstTile(engine), 0);
    goTo(T0 + 5);
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
    expect(nextBeat(engine).map((t) => t.id)).toContain(left.id); // still the target

    tapAt(engine, left, 0.1); // a little late
    expect(engine.getState().score).toBe(POINTS.perfect + POINTS.good);
    expect(nextBeat(engine)[0].beat).toBe(left.beat + 1);
  });

  it('are missed if only one of the pair gets tapped', () => {
    const { engine } = setup([double(), tap()]);
    tapAt(engine, engine.getTiles()[0], 0);
    goTo(T0 + MISS_AFTER + 0.05);
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
  /** [hold, tap, tap]: the hold tile comes first so its head and tail are easy to reason about. */
  function setupHold(rows = 3) {
    const context = setup([hold(rows), tap(), tap()]);
    return { ...context, tile: firstTile(context.engine) };
  }

  it.each([2, 3, 4])('are %i rows tall and end exactly when the next beat arrives', (rows) => {
    const { engine, tile } = setupHold(rows);
    goTo(T0); // let the next tile spawn
    expect(tile.rows).toBe(rows);
    expect(must(tile.hold).end).toBeCloseTo(T0 + rows / RATE, 9);
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    expect(next.time).toBeCloseTo(must(tile.hold).end, 9);
  });

  it('are pressed at the head, graded like a tap, and worth a bonus for finishing', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0);
    expect(tile.hold?.phase).toBe('holding');
    expect(tile.isHit).toBe(false);
    expect(engine.getState().score).toBe(POINTS.perfect);

    goTo(must(tile.hold).end - HOLD_RELEASE_TOLERANCE + 0.01);
    expect(tile.hold?.phase).toBe('done');
    expect(tile.isHit).toBe(true);
    expect(engine.getState().score).toBe(POINTS.perfect + HOLD_BONUS * comboMultiplier(1));

    engine.release('p1'); // letting go afterwards is fine
    expect(engine.getState().status).toBe('playing');
  });

  it('take longer the taller they are', () => {
    const ends = [2, 4].map((rows) => must(setupHold(rows).tile.hold).end - T0);
    expect(ends[1] - ends[0]).toBeCloseTo(2 / RATE, 9);
  });

  it('end the game if released too early', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0);
    goTo(T0 + 0.5);
    engine.release('p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('forgive a release within the tolerance of the end, but not beyond it', () => {
    const early = setupHold();
    tapAt(early.engine, early.tile, 0);
    songTime = must(early.tile.hold).end - HOLD_RELEASE_TOLERANCE - 0.02; // between frames
    early.engine.release('p1');
    expect(early.engine.getState().status).toBe('gameover');

    const ok = setupHold();
    tapAt(ok.engine, ok.tile, 0);
    songTime = must(ok.tile.hold).end - HOLD_RELEASE_TOLERANCE + 0.02;
    ok.engine.release('p1');
    expect(ok.engine.getState().status).toBe('playing');
    expect(ok.tile.isHit).toBe(true);
  });

  it('still have to be held to the same end when grabbed late', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0.25); // ok, and late
    expect(engine.getState().score).toBe(POINTS.ok);
    goTo(must(tile.hold).end - 0.5);
    engine.release('p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('are missed if never pressed', () => {
    const { engine } = setupHold();
    goTo(T0 + MISS_AFTER + 0.05);
    expect(engine.getState().status).toBe('gameover');
  });

  it('ignore a second finger while one is already holding', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0, 'p1');
    engine.press(tile.lane, 'p2');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: POINTS.perfect });
    expect(tile.hold?.pointer).toBe('p1');
  });

  it('keep the next beat off limits until the hold is finished', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0);
    const next = must(engine.getTiles().find((t) => t.beat === 1));
    next.lane = (tile.lane + 1) % 4;
    goTo(T0 + 0.6);
    engine.press(next.lane, 'p2');
    expect(engine.getState().status).toBe('gameover');
  });

  it('hand over to the next tile once finished', () => {
    const { engine, tile } = setupHold();
    tapAt(engine, tile, 0);
    goTo(must(tile.hold).end);
    const next = nextBeat(engine)[0];
    expect(next.beat).toBe(1);
    tapAt(engine, next, 0, 'p2');
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().score).toBe(POINTS.perfect + HOLD_BONUS + POINTS.perfect);
  });

  it('work from the keyboard too', () => {
    const { engine, tile } = setupHold();
    goTo(T0);
    engine.press(tile.lane, 'k:KeyD');
    expect(tile.hold?.phase).toBe('holding');
    goTo(T0 + 0.4);
    engine.release('k:KeyD');
    expect(engine.getState().status).toBe('gameover');
  });
});

describe('laps: the song ends and everything speeds up', () => {
  it('jumps the speed by a fixed factor each time the song finishes', () => {
    const { engine, calls, states } = setup([tap(), tap(), tap(), tap()]);
    playPerfectly(engine, () => engine.getState().lap >= 3);
    expect(engine.getState().status).toBe('playing');
    const speeds = [0, 1, 2, 3].map((lap) => states.find((s) => s.lap === lap)?.speedMultiplier);
    expect(speeds).toEqual([1, 1.3, 1.69, 2.2]);
    expect(calls.levelUps).toBe(3);
    expect(engine.getState().speedMultiplier).toBe(Math.round(LAP_SPEED_FACTOR ** 3 * 100) / 100);
  });

  it('starts the next lap exactly one song after the first, and plays it faster', () => {
    const { engine, scheduled } = setup([tap(), tap(), tap(), tap()]);
    playPerfectly(engine, () => engine.getState().lap >= 1);
    const rows = 4;
    expect(engine.getState().lap).toBe(1);
    const lap1Start = T0 + rows / RATE;
    goTo(lap1Start + 1);
    const lap0Gap = scheduled[1].at - scheduled[0].at;
    const lap1 = scheduled.filter((n) => n.at >= lap1Start - 1e-9);
    expect(lap1[0].at).toBeCloseTo(lap1Start, 9);
    expect(lap1[1].at - lap1[0].at).toBeCloseTo(lap0Gap / LAP_SPEED_FACTOR, 9);
  });

  it('makes tiles fall faster on later laps', () => {
    const { engine } = setup([tap(), tap()]);
    playPerfectly(engine, () => engine.getState().lap >= 1);
    const tile = must(nextBeat(engine)[0]);
    const y1 = tile.yPos;
    goTo(songTime + 0.1);
    expect(tile.yPos - y1).toBeCloseTo(SPEED * LAP_SPEED_FACTOR * 0.1, 5);
  });

  it('keeps the timing windows the same in seconds, so a perfect is still a perfect', () => {
    const { engine } = setup([tap(), tap()]);
    playPerfectly(engine, () => engine.getState().lap >= 2);
    const before = engine.getState().score;
    tapAt(engine, nextBeat(engine)[0], PERFECT_WINDOW - 0.01);
    expect(engine.getState().score - before).toBeGreaterThanOrEqual(POINTS.perfect);
  });

  it('reports laps in the final stats and saves the best lap count', () => {
    const { engine, results } = setup(manyTaps(8));
    playPerfectly(engine, () => engine.getState().lap >= 2);
    stepUntilOver(engine); // stop tapping and let the next tile be missed
    expect(engine.getState().status).toBe('gameover');
    expect(results[0].stats.laps).toBe(2);
  });
});

describe('progress, pausing and quitting', () => {
  it('tracks how far through the lap the song is', () => {
    const { engine } = setup([tap(), tap(), tap(), tap()]);
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
    const { engine, song } = setup([tap(), tap()]);
    goTo(T0 + 5); // miss
    expect(engine.getState().status).toBe('gameover');
    songTime = 500;
    engine.start(song);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, combo: 0, lap: 0 });
    expect(firstTile(engine).time).toBeCloseTo(500 + LEAD_ROWS / RATE, 9);
  });
});
