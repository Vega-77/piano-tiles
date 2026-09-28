import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TOLERANCE, TILE_HEIGHT } from '../config';
import type { BeatSpec, GameState, Song, Tile } from '../types';
import type { Sound } from './audio';
import { noopFx } from './effects';
import { GameEngine, speedForScore, type GameOverResult } from './engine';
import { getBest } from './storage';

// ---- a manual frame clock, so tests step the real rAF loop deterministically ----
let queue: FrameRequestCallback[] = [];
let clock = 0;

function step(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    const callbacks = queue;
    queue = [];
    clock += 1000 / 60;
    for (const callback of callbacks) callback(clock);
  }
}

beforeEach(() => {
  queue = [];
  clock = 0;
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
const SPEED = 50; // percent of board height per second => 50/60 per frame
const tap = (): BeatSpec => ({ type: 'tap', freq: 440 });
const double = (): BeatSpec => ({ type: 'double', freqs: [440, 550] });
const hold = (rows: number): BeatSpec => ({ type: 'hold', freq: 330, rows });

function makeSong(beats: BeatSpec[]): Song {
  return {
    id: 'test', title: 'Test', composer: 'Tester', description: '', difficulty: 1,
    speed: SPEED, hue: 200, hue2: 250, beats,
  };
}

interface PlayedNote { freq: number; sustain: boolean; released: boolean }

function setup(beats: BeatSpec[]) {
  const notes: PlayedNote[] = [];
  const states: GameState[] = [];
  const results: GameOverResult[] = [];
  const audio: Sound = {
    unlock() {},
    playNote(freq, options) {
      const note = { freq, sustain: options?.sustain ?? false, released: false };
      notes.push(note);
      return { release: () => { note.released = true; } };
    },
    playError() {},
    playLevelUp() {},
  };
  const engine = new GameEngine({
    layer: document.createElement('div'),
    audio,
    effects: noopFx,
    onStateChange: (state) => states.push(state),
    onGameOver: (result) => results.push(result),
  });
  const song = makeSong(beats);
  engine.start(song);
  step(1); // prime the frame clock so later frames have an exact dt
  return { engine, song, notes, states, results };
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

const headTop = (tile: Tile) => tile.yPos + (tile.rows - 1) * TILE_HEIGHT;
/** Tap a tile in the middle of its lowest row (the "head" of a hold tile). */
const tapTile = (engine: GameEngine, tile: Tile, key = 'p1') =>
  engine.press(tile.lane, headTop(tile) + TILE_HEIGHT / 2, key);

function stepUntil(condition: () => boolean, maxFrames = 1500): number {
  let frames = 0;
  while (!condition() && frames < maxFrames) {
    step();
    frames++;
  }
  return frames;
}

describe('speedForScore', () => {
  it('rises by 0.05 every 50 tiles', () => {
    expect(speedForScore(0)).toBe(1);
    expect(speedForScore(49)).toBe(1);
    expect(speedForScore(50)).toBe(1.05);
    expect(speedForScore(100)).toBe(1.1);
    expect(speedForScore(500)).toBe(1.5);
  });
});

describe('tap tiles', () => {
  it('starts idle: nothing moves until the first tap', () => {
    const { engine } = setup([tap(), tap(), tap()]);
    const before = engine.getTiles().map((t) => t.yPos);
    step(90);
    expect(engine.getTiles().map((t) => t.yPos)).toEqual(before);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0, songId: 'test' });
    expect(before[0]).toBe(50); // one blank runway row sits under the first tile
  });

  it('scores a hit, plays its note, and starts scrolling at the song speed', () => {
    const { engine, notes } = setup([tap(), tap(), tap()]);
    const first = engine.getTiles()[0];
    tapTile(engine, first);
    expect(first.isHit).toBe(true);
    expect(engine.getState().score).toBe(1);
    expect(notes).toEqual([{ freq: 440, sustain: false, released: false }]);

    const y = first.yPos;
    step(30);
    expect(first.yPos).toBeCloseTo(y + 25, 5); // 0.5s at 50%/s
  });

  it('keeps enough tiles queued to cover the board plus a row above', () => {
    const { engine } = setup([tap()]);
    for (let i = 0; i < 400; i++) {
      // Like a player, only tap what is actually on screen.
      const target = nextBeat(engine)[0];
      if (target && headTop(target) >= 0) tapTile(engine, target);
      step(5);
      const tiles = engine.getTiles();
      expect(tiles[tiles.length - 1].yPos).toBeLessThanOrEqual(-TILE_HEIGHT);
      expect(tiles.length).toBeLessThan(10); // scrolled-off tiles are recycled
    }
    expect(engine.getState().score).toBeGreaterThan(30);
    expect(engine.getState().status).toBe('playing');
  });

  it('ends the game on a tap in a white cell, and saves the run', () => {
    const { engine, results } = setup([tap(), tap()]);
    const first = engine.getTiles()[0];
    engine.press((first.lane + 1) % 4, first.yPos + 12, 'p1');
    expect(engine.getState().status).toBe('gameover');
    expect(results).toEqual([{ score: 0, isNewBest: false, songId: 'test' }]);
  });

  it('ends the game on a tap in the blank runway row', () => {
    const { engine } = setup([tap(), tap()]);
    engine.press(engine.getTiles()[0].lane, 90, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('ends the game when a tile is tapped out of order', () => {
    const { engine } = setup([tap(), tap()]);
    const second = engine.getTiles()[1];
    engine.press(second.lane, second.yPos + 12, 'p1');
    expect(engine.getState().status).toBe('gameover');
  });

  it('ignores a repeat tap on a tile that is already cleared', () => {
    const { engine } = setup([tap(), tap()]);
    const first = engine.getTiles()[0];
    tapTile(engine, first);
    tapTile(engine, first);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 1 });
  });

  it('ends the game when a tile scrolls off the bottom, and saves the score', () => {
    const { engine, results } = setup([tap(), tap()]);
    tapTile(engine, engine.getTiles()[0]);
    const frames = stepUntil(() => engine.getState().status === 'gameover');
    expect(engine.getState().status).toBe('gameover');
    expect(frames).toBeLessThan(200);
    expect(results).toEqual([{ score: 1, isNewBest: true, songId: 'test' }]);
    expect(getBest('test')).toBe(1);
  });

  it('speeds up by 0.05 every 50 tiles', () => {
    const { engine, states } = setup([tap()]);
    stepUntil(() => {
      for (const tile of nextBeat(engine)) tapTile(engine, tile);
      return engine.getState().score >= 101;
    }, 8000);
    expect(states.find((s) => s.score === 49)?.speedMultiplier).toBe(1);
    expect(states.find((s) => s.score === 50)?.speedMultiplier).toBe(1.05);
    expect(states.find((s) => s.score === 100)?.speedMultiplier).toBe(1.1);
    expect(engine.getState().status).toBe('playing');
  });

  it('tracks progress through the song and wraps around', () => {
    const { engine } = setup([tap(), tap(), tap(), tap()]);
    tapTile(engine, nextBeat(engine)[0]);
    expect(engine.getState().progress).toBe(0.25);
    step(10);
    tapTile(engine, nextBeat(engine)[0]);
    expect(engine.getState().progress).toBe(0.5);
  });

  it('can go back to the menu, and start again cleanly', () => {
    const { engine, song } = setup([tap(), tap()]);
    tapTile(engine, engine.getTiles()[0]);
    engine.quit();
    expect(engine.getState()).toMatchObject({ status: 'menu', score: 0 });
    expect(engine.getTiles()).toHaveLength(0);

    engine.start(song);
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 0 });
    expect(engine.getTiles()[0].yPos).toBe(50);
  });
});

describe('double tiles', () => {
  it('lay two tiles in one row with exactly one lane between them', () => {
    for (let i = 0; i < 30; i++) {
      const { engine } = setup([double(), double()]);
      const [left, right] = engine.getTiles();
      expect(left.yPos).toBe(right.yPos);
      expect(left.beat).toBe(right.beat);
      expect(right.lane - left.lane).toBe(2);
      expect([0, 1]).toContain(left.lane);
      expect([left.freq, right.freq]).toEqual([440, 550]);
    }
  });

  it('need both tiles tapped, in either order, before the beat is cleared', () => {
    const { engine, notes } = setup([double(), tap(), tap()]);
    const [left, right] = engine.getTiles();
    tapTile(engine, right);
    expect(engine.getState()).toMatchObject({ score: 1, progress: 0 });
    expect(nextBeat(engine).map((t) => t.id)).toContain(left.id); // still the target

    tapTile(engine, left);
    expect(engine.getState()).toMatchObject({ score: 2 });
    expect(engine.getState().progress).toBeCloseTo(1 / 3, 5);
    expect(nextBeat(engine)[0].beat).toBe(left.beat + 1);
    expect(notes.map((n) => n.freq)).toEqual([550, 440]);
  });

  it('do not let the next beat be tapped first', () => {
    const { engine } = setup([double(), tap()]);
    const [left] = engine.getTiles();
    tapTile(engine, left);
    const next = engine.getTiles().find((t) => t.beat === left.beat + 1);
    tapTile(engine, must(next));
    expect(engine.getState().status).toBe('gameover');
  });

  it('are missed if only one of the pair gets tapped', () => {
    const { engine } = setup([double(), tap()]);
    tapTile(engine, engine.getTiles()[0]);
    stepUntil(() => engine.getState().status === 'gameover');
    expect(engine.getState().status).toBe('gameover');
    expect(engine.getState().score).toBe(1);
  });

  it('work from the keyboard by lane', () => {
    const { engine } = setup([double(), tap()]);
    const [left, right] = engine.getTiles();
    engine.press(left.lane, undefined, 'k:a');
    engine.press(left.lane, undefined, 'k:a'); // a repeat press on a cleared lane is harmless
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 1 });
    engine.press(right.lane, undefined, 'k:b');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 2 });
  });

  it('end the game from the keyboard when a lane without a tile is pressed', () => {
    const { engine } = setup([double(), tap()]);
    const [left] = engine.getTiles();
    engine.press((left.lane + 1) % 4, undefined, 'k:x'); // the gap lane between the pair
    expect(engine.getState().status).toBe('gameover');
  });
});

describe('hold tiles', () => {
  /** [tap, hold, tap]: clear the opening tap, then hand back the hold tile. */
  function setupHold(rows = 3) {
    const context = setup([tap(), hold(rows), tap(), tap()]);
    tapTile(context.engine, context.engine.getTiles()[0]);
    step(2);
    const holdTile = must(context.engine.getTiles().find((t) => t.kind === 'hold'));
    return { ...context, holdTile };
  }

  it.each([2, 3, 4])('are %i rows tall and sit flush against their neighbours', (rows) => {
    const { engine, holdTile } = setupHold(rows);
    expect(holdTile.rows).toBe(rows);
    const [opening] = engine.getTiles();
    expect(holdTile.yPos + rows * TILE_HEIGHT).toBeCloseTo(opening.yPos, 5); // flush below
    const above = engine.getTiles().find((t) => t.beat === holdTile.beat + 1);
    if (above) expect(above.yPos + TILE_HEIGHT).toBeCloseTo(holdTile.yPos, 5); // flush above
  });

  it('start a sustained note when pressed, worth a point', () => {
    const { engine, holdTile, notes } = setupHold();
    tapTile(engine, holdTile);
    expect(holdTile.hold?.phase).toBe('holding');
    expect(holdTile.isHit).toBe(false);
    expect(engine.getState().score).toBe(2);
    expect(notes[1]).toEqual({ freq: 330, sustain: true, released: false });
  });

  it('must be held until the tile has flowed past the finger', () => {
    const { engine, holdTile, notes } = setupHold(3);
    tapTile(engine, holdTile);
    step(15);
    expect(holdTile.isHit).toBe(false);
    expect(engine.getState().status).toBe('playing');

    stepUntil(() => holdTile.isHit, 600);
    expect(holdTile.hold?.phase).toBe('done');
    expect(holdTile.yPos).toBeGreaterThanOrEqual(must(holdTile.hold).line - HOLD_TOLERANCE);
    expect(engine.getState().score).toBe(3); // tap + press + finish
    expect(notes[1].released).toBe(true);

    engine.release('p1'); // letting go afterwards is fine
    expect(engine.getState().status).toBe('playing');
  });

  it('takes longer to finish the taller the tile is', () => {
    const frames = [2, 4].map((rows) => {
      const { engine, holdTile } = setupHold(rows);
      tapTile(engine, holdTile);
      return stepUntil(() => holdTile.isHit, 800) + engine.getState().score * 0;
    });
    expect(frames[1] - frames[0]).toBeGreaterThan(40); // two extra rows at 30 frames each, minus slack
  });

  it('end the game if released too early', () => {
    const { engine, holdTile, notes } = setupHold();
    tapTile(engine, holdTile);
    step(10);
    engine.release('p1');
    expect(engine.getState().status).toBe('gameover');
    expect(notes[1].released).toBe(true);
  });

  it('forgive a release within the tolerance of the end, but not further', () => {
    const early = setupHold();
    tapTile(early.engine, early.holdTile);
    early.holdTile.yPos = must(early.holdTile.hold).line - HOLD_TOLERANCE - 0.1;
    early.engine.release('p1');
    expect(early.engine.getState().status).toBe('gameover');

    const ok = setupHold();
    tapTile(ok.engine, ok.holdTile);
    ok.holdTile.yPos = must(ok.holdTile.hold).line - HOLD_TOLERANCE + 0.1;
    ok.engine.release('p1');
    expect(ok.engine.getState().status).toBe('playing');
    expect(ok.holdTile.isHit).toBe(true);
  });

  it('cannot be shortened by pressing high up on the tile', () => {
    const { engine, holdTile } = setupHold(4);
    engine.press(holdTile.lane, holdTile.yPos + 2, 'p1'); // near the far end, not the head
    expect(must(holdTile.hold).line).toBeCloseTo(headTop(holdTile), 5);
  });

  it('measure from the finger when pressed low in the head row', () => {
    const { engine, holdTile } = setupHold(3);
    engine.press(holdTile.lane, headTop(holdTile) + 20, 'p1');
    expect(must(holdTile.hold).line).toBeCloseTo(headTop(holdTile) + 20, 5);
  });

  it('are missed if never pressed', () => {
    const { engine } = setupHold();
    stepUntil(() => engine.getState().status === 'gameover');
    expect(engine.getState().status).toBe('gameover');
    expect(engine.getState().score).toBe(1);
  });

  it('ignore a second finger while one is already holding', () => {
    const { engine, holdTile } = setupHold();
    tapTile(engine, holdTile, 'p1');
    tapTile(engine, holdTile, 'p2');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 2 });
    expect(holdTile.hold?.pointer).toBe('p1');
  });

  it('keep the next beat off limits until the hold is finished', () => {
    const { engine, holdTile } = setupHold();
    tapTile(engine, holdTile);
    const next = must(engine.getTiles().find((t) => t.beat === holdTile.beat + 1));
    tapTile(engine, next, 'p2');
    expect(engine.getState().status).toBe('gameover');
  });

  it('hand over to the next tile once finished', () => {
    const { engine, holdTile } = setupHold();
    tapTile(engine, holdTile);
    stepUntil(() => holdTile.isHit, 600);
    const next = nextBeat(engine)[0];
    expect(next.kind).toBe('tap');
    tapTile(engine, next, 'p2');
    expect(engine.getState()).toMatchObject({ status: 'playing', score: 4 });
  });

  it('work from the keyboard: press to grab, keep the key down to finish', () => {
    const { engine, holdTile } = setupHold(3);
    engine.press(holdTile.lane, undefined, 'k:KeyD');
    expect(holdTile.hold?.phase).toBe('holding');
    step(10);
    engine.release('k:KeyD');
    expect(engine.getState().status).toBe('gameover');

    const again = setupHold(3);
    again.engine.press(again.holdTile.lane, undefined, 'k:KeyD');
    stepUntil(() => again.holdTile.isHit, 600);
    again.engine.release('k:KeyD');
    expect(again.engine.getState().status).toBe('playing');
  });

  it('cut the sustained note off when the game ends for another reason', () => {
    const { engine, holdTile, notes } = setupHold();
    tapTile(engine, holdTile);
    const wrong = (holdTile.lane + 1) % 4;
    engine.press(wrong, holdTile.yPos + 10, 'p2'); // white cell elsewhere on the tile
    expect(engine.getState().status).toBe('gameover');
    expect(notes[1].released).toBe(true);
  });
});
