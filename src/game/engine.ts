import {
  HOLD_TOLERANCE,
  LANES,
  MAX_FRAME_DT,
  RUNWAY_TOP,
  SPEED_STEP,
  TILE_HEIGHT,
  TILES_PER_SPEED_STEP,
} from '../config';
import type { GameState, Song, Tile } from '../types';
import type { NoteHandle, Sound } from './audio';
import type { Fx } from './effects';
import { TileRenderer } from './renderer';
import { getBest, recordRun } from './storage';

export interface GameOverResult {
  score: number;
  isNewBest: boolean;
  songId: string;
}

interface EngineOptions {
  /** Empty element the engine fills with tile nodes (React must not render children in it). */
  layer: HTMLElement;
  audio: Sound;
  effects: Fx;
  /** Fired on discrete events only (start, each score, game over) — never per frame. */
  onStateChange: (state: GameState) => void;
  onGameOver?: (result: GameOverResult) => void;
}

type Failure =
  | { kind: 'miss'; tiles: Tile[] }
  | { kind: 'released'; tile: Tile }
  | { kind: 'wrong'; lane: number; rowY: number };

export function createInitialState(): GameState {
  return { status: 'menu', score: 0, speedMultiplier: 1, highScore: 0, songId: '', progress: 0 };
}

export function speedForScore(score: number): number {
  const steps = Math.floor(score / TILES_PER_SPEED_STEP);
  return Math.round((1 + SPEED_STEP * steps) * 100) / 100;
}

const laneCenter = (lane: number): number => (lane + 0.5) * (100 / LANES);
/** Top edge of a tile's lowest row: the "head" that hold tiles are grabbed by. */
const headTop = (tile: Tile): number => tile.yPos + (tile.rows - 1) * TILE_HEIGHT;

/**
 * The game loop and rules, kept outside React. Tiles live in a plain array and are moved by
 * requestAnimationFrame; React only hears about score/status changes.
 *
 * A song is a list of beats. Each beat is laid down as a group of tiles stacked in rows: one
 * tile (tap), two tiles in the same row one lane apart (double), or one tall tile (hold).
 * Beats must be cleared bottom to top.
 */
export class GameEngine {
  private readonly renderer: TileRenderer;
  private readonly audio: Sound;
  private readonly effects: Fx;
  private readonly onStateChange: (state: GameState) => void;
  private readonly onGameOver?: (result: GameOverResult) => void;

  private state = createInitialState();
  private song: Song | null = null;
  /** Lowest (oldest) beat first, so top edges only ever decrease along the array. */
  private tiles: Tile[] = [];
  private nextId = 0;
  /** Index of the next beat to spawn; wraps around the song, so it plays forever. */
  private cursor = 0;
  private beatsCleared = 0;
  /** Tiles hold still until the first tap so the player isn't rushed. */
  private scrolling = false;
  private readonly heldNotes = new Map<string, NoteHandle>();
  private rafId = 0;
  private lastTime = 0;

  constructor(options: EngineOptions) {
    this.renderer = new TileRenderer(options.layer);
    this.audio = options.audio;
    this.effects = options.effects;
    this.onStateChange = options.onStateChange;
    this.onGameOver = options.onGameOver;
  }

  getState(): GameState {
    return this.state;
  }

  getTiles(): readonly Tile[] {
    return this.tiles;
  }

  start(song: Song): void {
    cancelAnimationFrame(this.rafId);
    this.releaseNotes();
    this.audio.unlock();
    this.renderer.clear();

    this.song = song;
    this.tiles = [];
    this.cursor = 0;
    this.beatsCleared = 0;
    this.scrolling = false;
    this.lastTime = 0;

    this.effects.setTheme(song.hue, song.hue2);
    this.effects.setEnergy(0);

    this.fillAbove(RUNWAY_TOP);
    this.refreshTargets();
    this.draw();

    this.setState({
      status: 'playing',
      score: 0,
      speedMultiplier: 1,
      highScore: getBest(song.id),
      songId: song.id,
      progress: 0,
    });
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Abandon the current run and go back to the song list. */
  quit(): void {
    cancelAnimationFrame(this.rafId);
    this.releaseNotes();
    this.renderer.clear();
    this.tiles = [];
    this.scrolling = false;
    this.effects.setEnergy(0);
    this.setState({ status: 'menu', score: 0, speedMultiplier: 1, progress: 0 });
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.releaseNotes();
    this.renderer.clear();
  }

  /**
   * A finger (or key) went down. `y` is percent of board height; without it (keyboard) only
   * the lane is checked. `key` identifies the pointer so a hold can be released later.
   */
  press(lane: number, y: number | undefined, key: string): void {
    if (this.state.status !== 'playing') return;
    const beat = this.targetBeat();
    if (beat < 0) return;

    if (y === undefined) {
      const tile = this.tiles.find((t) => t.beat === beat && t.lane === lane);
      if (!tile) {
        const anchor = this.tiles.find((t) => t.beat === beat);
        this.endGame({ kind: 'wrong', lane, rowY: anchor ? headTop(anchor) : RUNWAY_TOP });
      } else if (this.isPressable(tile)) {
        this.hit(tile, key, undefined);
      }
      return;
    }

    const tile = this.tiles.find((t) => t.lane === lane && y >= t.yPos && y < t.yPos + t.rows * TILE_HEIGHT);
    if (tile) {
      if (!this.isPressable(tile)) return; // already cleared or being held: a double-tap isn't fatal
      if (tile.beat === beat) this.hit(tile, key, y);
      else this.endGame({ kind: 'wrong', lane, rowY: this.rowTop(tile, y) }); // skipped ahead
      return;
    }
    // A white cell, or the blank runway row under the first beat.
    this.endGame({ kind: 'wrong', lane, rowY: this.rowAt(y) });
  }

  /** A finger (or key) came up. Letting go of a hold tile too early ends the game. */
  release(key: string): void {
    if (this.state.status !== 'playing') return;
    const tile = this.tiles.find((t) => t.hold?.phase === 'holding' && t.hold.pointer === key);
    if (!tile?.hold) return;
    if (tile.yPos >= tile.hold.line - HOLD_TOLERANCE) this.completeHold(tile);
    else this.endGame({ kind: 'released', tile });
  }

  private frame = (now: number): void => {
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT) : 0;
    this.lastTime = now;

    if (this.scrolling) {
      this.advance(dt);
      if (this.state.status !== 'playing') return;
      this.draw();
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  private advance(dt: number): void {
    const song = this.song;
    if (!song) return;
    const dy = song.speed * this.state.speedMultiplier * dt;
    for (const tile of this.tiles) tile.yPos += dy;

    for (const tile of this.tiles) {
      const hold = tile.hold;
      if (hold?.phase !== 'holding') continue;
      if (tile.yPos >= hold.line - HOLD_TOLERANCE) {
        this.completeHold(tile);
      } else {
        this.renderer.setHoldProgress(tile.id, this.holdProgress(tile, hold.line));
        this.effects.stream(laneCenter(tile.lane), hold.line);
      }
    }

    // A beat is missed once its head row has scrolled off the bottom without being pressed.
    const beat = this.targetBeat();
    const missed = this.tiles.filter(
      (t) => t.beat === beat && !t.isHit && t.hold?.phase !== 'holding' && headTop(t) >= 100,
    );
    if (missed.length > 0) {
      this.endGame({ kind: 'miss', tiles: missed });
      return;
    }

    while (this.tiles.length > 0 && this.tiles[0].isHit && this.tiles[0].yPos >= 100) {
      const gone = this.tiles.shift();
      if (gone) this.renderer.remove(gone.id);
    }
    if (this.fillAbove()) this.refreshTargets();
  }

  private hit(tile: Tile, key: string, y: number | undefined): void {
    const x = laneCenter(tile.lane);
    if (tile.kind === 'tap') {
      tile.isHit = true;
      this.renderer.markHit(tile.id);
      this.audio.playNote(tile.freq);
      this.effects.hit(x, tile.yPos + TILE_HEIGHT / 2, tile.lane);
      this.effects.popup('+1', x, tile.yPos);
      this.scored(1, tile);
      return;
    }

    // Hold: grabbing it anywhere counts as grabbing the head, so pressing high up on the tile
    // can't shorten the hold. The player must keep holding until its top edge reaches `line`.
    const head = headTop(tile);
    const line = Math.min(100, Math.max(head, y ?? head + TILE_HEIGHT / 2));
    tile.hold = { phase: 'holding', pointer: key, line };
    this.renderer.markHolding(tile.id);
    this.heldNotes.set(tile.id, this.audio.playNote(tile.freq, { sustain: true }));
    this.effects.hit(x, line, tile.lane);
    this.effects.popup('+1', x, line - TILE_HEIGHT / 2);
    this.scored(1, tile);
  }

  private completeHold(tile: Tile): void {
    const hold = tile.hold;
    if (hold?.phase !== 'holding') return;
    hold.phase = 'done';
    hold.pointer = null;
    tile.isHit = true;
    this.renderer.markDone(tile.id);
    this.heldNotes.get(tile.id)?.release();
    this.heldNotes.delete(tile.id);
    const x = laneCenter(tile.lane);
    this.effects.hit(x, hold.line, tile.lane);
    this.effects.popup('+1', x, hold.line - TILE_HEIGHT / 2);
    this.scored(1, tile);
  }

  private scored(points: number, tile: Tile): void {
    const previousSpeed = this.state.speedMultiplier;
    const score = this.state.score + points;
    const speedMultiplier = speedForScore(score);
    this.scrolling = true;

    if (this.tiles.every((t) => t.beat !== tile.beat || t.isHit)) this.beatsCleared++;
    this.refreshTargets();

    if (speedMultiplier > previousSpeed) {
      this.effects.setEnergy((speedMultiplier - 1) * 2);
      this.effects.pulse(1);
      this.audio.playLevelUp();
    }
    const total = this.song?.beats.length || 1;
    this.setState({ score, speedMultiplier, progress: (this.beatsCleared % total) / total });
  }

  private endGame(failure: Failure): void {
    if (this.state.status !== 'playing') return;
    cancelAnimationFrame(this.rafId);
    this.releaseNotes();

    let x = 50;
    let y = 80;
    if (failure.kind === 'miss') {
      // The missed tiles have scrolled off-screen; slide the board back to show them in red.
      const shift = headTop(failure.tiles[0]) - RUNWAY_TOP;
      for (const tile of this.tiles) tile.yPos -= shift;
      for (const tile of failure.tiles) this.renderer.markMiss(tile.id);
      this.renderer.enableSettling();
      this.draw();
      x = laneCenter(failure.tiles[0].lane);
      y = RUNWAY_TOP + TILE_HEIGHT / 2;
    } else if (failure.kind === 'released') {
      this.renderer.markMiss(failure.tile.id);
      x = laneCenter(failure.tile.lane);
      y = failure.tile.hold?.line ?? y;
    } else {
      this.renderer.showError(failure.lane, failure.rowY);
      x = laneCenter(failure.lane);
      y = failure.rowY + TILE_HEIGHT / 2;
    }
    this.audio.playError();
    this.effects.fail(x, y);

    const { score, songId } = this.state;
    const { stats, isNewBest } = recordRun(songId, score);
    this.setState({ status: 'gameover', highScore: stats.best });
    this.onGameOver?.({ score, isNewBest, songId });
  }

  /** The lowest beat that still has an uncleared tile, or -1. */
  private targetBeat(): number {
    return this.tiles.find((t) => !t.isHit)?.beat ?? -1;
  }

  private isPressable(tile: Tile): boolean {
    return !tile.isHit && tile.hold?.phase !== 'holding';
  }

  private refreshTargets(): void {
    const beat = this.targetBeat();
    for (const tile of this.tiles) this.renderer.setTarget(tile.id, tile.beat === beat && !tile.isHit);
  }

  /** Fraction (0–1) of a held tile that has flowed past the finger. */
  private holdProgress(tile: Tile, line: number): number {
    const length = tile.rows * TILE_HEIGHT;
    return Math.max(0, Math.min(1, (tile.yPos + length - line) / length));
  }

  /** Top edge of the row that contains `y` inside a tile. */
  private rowTop(tile: Tile, y: number): number {
    return tile.yPos + Math.floor((y - tile.yPos) / TILE_HEIGHT) * TILE_HEIGHT;
  }

  private rowAt(y: number): number {
    const tile = this.tiles.find((t) => y >= t.yPos && y < t.yPos + t.rows * TILE_HEIGHT);
    return tile ? this.rowTop(tile, y) : RUNWAY_TOP;
  }

  /** Queue up beats until the board is covered plus one row above the top. Returns whether any spawned. */
  private fillAbove(from = this.tiles[this.tiles.length - 1]?.yPos ?? RUNWAY_TOP): boolean {
    let top = from;
    let spawned = false;
    while (top > -TILE_HEIGHT) {
      top = this.spawnBeat(top);
      spawned = true;
    }
    return spawned;
  }

  /** Lay the next beat of the song directly above `bottom`; returns its top edge. */
  private spawnBeat(bottom: number): number {
    const song = this.song;
    if (!song) return bottom;
    const beat = this.cursor++;
    const spec = song.beats[beat % song.beats.length];
    const first = beat === 0;

    if (spec.type === 'double') {
      // Exactly one lane between the two tiles: lanes 0 & 2, or 1 & 3.
      const lanes = Math.random() < 0.5 ? [0, 2] : [1, 3];
      const top = bottom - TILE_HEIGHT;
      lanes.forEach((lane, i) =>
        this.addTile({ beat, lane, top, rows: 1, kind: 'tap', freq: spec.freqs[i] }, { label: first ? 'Tap' : '', link: i === 0 }),
      );
      return top;
    }

    const rows = spec.type === 'hold' ? spec.rows : 1;
    const top = bottom - rows * TILE_HEIGHT;
    const lane = Math.floor(Math.random() * LANES);
    this.addTile({ beat, lane, top, rows, kind: spec.type, freq: spec.freq }, { label: first ? 'Tap' : '' });
    return top;
  }

  private addTile(
    spec: Pick<Tile, 'beat' | 'lane' | 'rows' | 'kind' | 'freq'> & { top: number },
    options: { label?: string; link?: boolean },
  ): void {
    const tile: Tile = {
      id: `tile-${this.nextId++}`,
      lane: spec.lane,
      yPos: spec.top,
      isHit: false,
      kind: spec.kind,
      rows: spec.rows,
      beat: spec.beat,
      freq: spec.freq,
      hold: spec.kind === 'hold' ? { phase: 'pending', pointer: null, line: 0 } : null,
    };
    this.tiles.push(tile);
    this.renderer.add(tile, options);
  }

  private releaseNotes(): void {
    for (const note of this.heldNotes.values()) note.release();
    this.heldNotes.clear();
  }

  private draw(): void {
    for (const tile of this.tiles) this.renderer.draw(tile);
  }

  private setState(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }
}
