import {
  BASE_SPEED,
  FIRST_TILE_Y,
  LANES,
  MAX_FRAME_DT,
  SPEED_STEP,
  TILE_HEIGHT,
  TILES_PER_SPEED_STEP,
} from '../config';
import type { GameState, Tile } from '../types';
import type { AudioEngine } from './audio';
import { TileRenderer } from './renderer';
import { loadHighScore, saveHighScore } from './storage';

export interface GameOverResult {
  score: number;
  isNewBest: boolean;
}

interface EngineOptions {
  /** Empty element the engine fills with tile nodes (React must not render children in it). */
  layer: HTMLElement;
  audio: AudioEngine;
  /** Fired on discrete events only (start, each hit, game over) — never per frame. */
  onStateChange: (state: GameState) => void;
  onGameOver?: (result: GameOverResult) => void;
}

type Failure =
  | { kind: 'miss'; tile: Tile }
  | { kind: 'wrong'; lane: number; rowY: number };

export function createInitialState(highScore: number): GameState {
  return { status: 'menu', score: 0, speedMultiplier: 1, highScore };
}

function speedForScore(score: number): number {
  const steps = Math.floor(score / TILES_PER_SPEED_STEP);
  return Math.round((1 + SPEED_STEP * steps) * 100) / 100;
}

/**
 * The game loop and rules, kept outside React. Tiles live in a plain array and are
 * moved by requestAnimationFrame; React only hears about score/status changes.
 */
export class GameEngine {
  private readonly renderer: TileRenderer;
  private readonly audio: AudioEngine;
  private readonly onStateChange: (state: GameState) => void;
  private readonly onGameOver?: (result: GameOverResult) => void;

  private state = createInitialState(loadHighScore());
  /** Lowest (oldest) tile first. Hit tiles form a prefix; the rest are still to tap. */
  private tiles: Tile[] = [];
  private nextId = 0;
  /** Tiles hold still until the first tap so the player isn't rushed. */
  private scrolling = false;
  private rafId = 0;
  private lastTime = 0;

  constructor(options: EngineOptions) {
    this.renderer = new TileRenderer(options.layer);
    this.audio = options.audio;
    this.onStateChange = options.onStateChange;
    this.onGameOver = options.onGameOver;
  }

  getState(): GameState {
    return this.state;
  }

  start(): void {
    cancelAnimationFrame(this.rafId);
    this.audio.unlock();
    this.renderer.clear();
    this.tiles = [];
    this.scrolling = false;
    this.lastTime = 0;

    this.addTile(FIRST_TILE_Y, 'Tap');
    this.fillAbove();
    this.draw();

    this.setState({ status: 'playing', score: 0, speedMultiplier: 1 });
    this.rafId = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.clear();
  }

  /**
   * Register a tap. With `y` (percent of board height) the tap must land on the black
   * cell of the lowest untapped tile; without it (keyboard) only the lane is checked.
   */
  tap(lane: number, y?: number): void {
    if (this.state.status !== 'playing') return;
    const target = this.nextTarget();
    if (!target) return;

    if (y === undefined) {
      if (lane === target.lane) this.hit(target);
      else this.endGame({ kind: 'wrong', lane, rowY: target.yPos });
      return;
    }

    const row = this.tiles.find((t) => y >= t.yPos && y < t.yPos + TILE_HEIGHT);
    if (row && row.lane === lane) {
      if (row === target) this.hit(row);
      else if (!row.isHit) this.endGame({ kind: 'wrong', lane, rowY: row.yPos }); // skipped ahead
      // Re-tapping a tile that's already cleared is ignored, so a double-tap isn't fatal.
      return;
    }
    // A white cell, or the blank runway row under the first tile.
    this.endGame({ kind: 'wrong', lane, rowY: row ? row.yPos : 100 - TILE_HEIGHT });
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
    const dy = BASE_SPEED * this.state.speedMultiplier * dt;
    for (const tile of this.tiles) tile.yPos += dy;

    const target = this.nextTarget();
    if (target && target.yPos >= 100) {
      this.endGame({ kind: 'miss', tile: target });
      return;
    }

    while (this.tiles.length > 0 && this.tiles[0].isHit && this.tiles[0].yPos >= 100) {
      const gone = this.tiles.shift()!;
      this.renderer.remove(gone.id);
    }
    this.fillAbove();
  }

  private hit(tile: Tile): void {
    tile.isHit = true;
    this.renderer.markHit(tile.id);
    this.audio.playNote(this.state.score);
    this.scrolling = true;

    const score = this.state.score + 1;
    this.setState({ score, speedMultiplier: speedForScore(score) });
  }

  private endGame(failure: Failure): void {
    if (this.state.status !== 'playing') return;
    cancelAnimationFrame(this.rafId);

    if (failure.kind === 'miss') {
      // The missed tile has scrolled off-screen; slide the board back to show it in red.
      const shift = failure.tile.yPos - (100 - TILE_HEIGHT);
      for (const tile of this.tiles) tile.yPos -= shift;
      this.renderer.markMiss(failure.tile.id);
      this.renderer.enableSettling();
      this.draw();
    } else {
      this.renderer.showError(failure.lane, failure.rowY);
    }
    this.audio.playError();

    const { score, highScore } = this.state;
    const isNewBest = score > highScore;
    if (isNewBest) saveHighScore(score);
    this.setState({ status: 'gameover', highScore: isNewBest ? score : highScore });
    this.onGameOver?.({ score, isNewBest });
  }

  private nextTarget(): Tile | undefined {
    return this.tiles.find((t) => !t.isHit);
  }

  /** Keep tiles queued up to one row above the visible top. */
  private fillAbove(): void {
    let top = this.tiles.length > 0 ? this.tiles[this.tiles.length - 1].yPos : FIRST_TILE_Y + TILE_HEIGHT;
    while (top > -TILE_HEIGHT) {
      top -= TILE_HEIGHT;
      this.addTile(top);
    }
  }

  private addTile(yPos: number, label?: string): void {
    const tile: Tile = {
      id: `tile-${this.nextId++}`,
      lane: Math.floor(Math.random() * LANES),
      yPos,
      isHit: false,
    };
    this.tiles.push(tile);
    this.renderer.add(tile, label);
  }

  private draw(): void {
    for (const tile of this.tiles) this.renderer.draw(tile);
  }

  private setState(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }
}
