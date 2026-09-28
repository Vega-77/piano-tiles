import {
  BAR_Y,
  COMBO_MAX_MULTIPLIER,
  COMBO_STEP,
  DOUBLE_TAP_GUARD,
  GOOD_WINDOW,
  HOLD_BONUS,
  HOLD_RELEASE_TOLERANCE,
  LANES,
  LEAD_ROWS,
  MISS_AFTER,
  NOTE_LOOKAHEAD,
  PERFECT_WINDOW,
  POINTS,
  TILE_HEIGHT,
} from '../config';
import { songRows } from '../songs/songs';
import type { GameState, Judgment, Song, Tile } from '../types';
import type { Sound } from './audio';
import type { BarZone, Fx } from './effects';
import { TileRenderer } from './renderer';
import { getBest, recordRun } from './storage';
import { Timeline } from './timeline';

export interface RunStats {
  perfect: number;
  good: number;
  ok: number;
  maxChain: number;
  tiles: number;
  laps: number;
}

export interface GameOverResult {
  score: number;
  isNewBest: boolean;
  songId: string;
  stats: RunStats;
}

interface EngineOptions {
  /** Empty element the engine fills with tile nodes (React must not render children in it). */
  layer: HTMLElement;
  audio: Sound;
  effects: Fx;
  /** Fired on discrete events only (start, each score, each lap, game over) — never per frame. */
  onStateChange: (state: GameState) => void;
  onGameOver?: (result: GameOverResult) => void;
}

type Failure =
  | { kind: 'miss'; tiles: Tile[] }
  | { kind: 'released'; tile: Tile }
  | { kind: 'wrong'; lane: number; rowY: number };

const JUDGMENT_LABEL: Record<Judgment, string> = { perfect: 'PERFECT', good: 'GOOD', ok: 'OK' };

/** Upper bound on notes handed to the audio clock in a single frame. */
const MAX_NOTES_PER_FRAME = 256;

export function createInitialState(): GameState {
  return {
    status: 'menu',
    score: 0,
    speedMultiplier: 1,
    highScore: 0,
    songId: '',
    progress: 0,
    combo: 0,
    comboMultiplier: 1,
    lap: 0,
    paused: false,
  };
}

/** Points multiplier for a chain of consecutive perfects. */
export function comboMultiplier(combo: number): number {
  return Math.min(COMBO_MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));
}

/** Grade a tap by how far (seconds) it was from the moment the tile reached the bar. Negative = early. */
export function judge(delta: number): { judgment: Judgment; early: boolean } {
  const distance = Math.abs(delta);
  const judgment = distance <= PERFECT_WINDOW ? 'perfect' : distance <= GOOD_WINDOW ? 'good' : 'ok';
  return { judgment, early: delta < 0 };
}

const laneCenter = (lane: number): number => (lane + 0.5) * (100 / LANES);
/** Top edge of a tile's lowest row: the "head" that hold tiles are grabbed by. */
const headTop = (tile: Tile): number => tile.yPos + (tile.rows - 1) * TILE_HEIGHT;
const bottomEdge = (tile: Tile): number => tile.yPos + tile.rows * TILE_HEIGHT;

/**
 * The game loop and rules, kept outside React.
 *
 * One clock rules everything: the audio clock. A `Timeline` says when each beat of the song
 * reaches the timing bar; tiles are drawn wherever that puts them, and the music is scheduled
 * ahead of time for the same moments. So the tiles are always on the beat, the song plays on
 * its own whether or not you tap, and a tap is graded purely by how close it landed to the
 * moment its tile reached the bar. Finishing the song speeds the whole thing up.
 */
export class GameEngine {
  private readonly renderer: TileRenderer;
  private readonly audio: Sound;
  private readonly effects: Fx;
  private readonly onStateChange: (state: GameState) => void;
  private readonly onGameOver?: (result: GameOverResult) => void;

  private state = createInitialState();
  private song: Song | null = null;
  private timeline: Timeline | null = null;
  private beatStarts: number[] = [];
  private rowsPerLap = 1;
  /** Lowest (oldest) beat first, so top edges only ever decrease along the array. */
  private tiles: Tile[] = [];
  private nextId = 0;
  /** Next beat to lay out / to schedule music for, counting across laps. */
  private spawnCursor = 0;
  private noteCursor = 0;
  /** Rows scrolled at the last sync. */
  private scroll = 0;
  private lap = 0;
  private combo = 0;
  private stats: RunStats = { perfect: 0, good: 0, ok: 0, maxChain: 0, tiles: 0, laps: 0 };
  private lastCleared: { lane: number; time: number } | null = null;
  private rafId = 0;

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
    this.audio.unlock();
    this.audio.startSong();
    this.renderer.clear();

    let row = 0;
    this.beatStarts = song.beats.map((beat) => {
      const start = row;
      row += beat.type === 'hold' ? beat.rows : 1;
      return start;
    });
    this.rowsPerLap = songRows(song);
    const baseRate = song.speed / TILE_HEIGHT;
    const now = this.audio.now();

    this.song = song;
    this.timeline = new Timeline(baseRate, this.rowsPerLap, now + LEAD_ROWS / baseRate);
    this.tiles = [];
    this.spawnCursor = 0;
    this.noteCursor = 0;
    this.lap = 0;
    this.combo = 0;
    this.stats = { perfect: 0, good: 0, ok: 0, maxChain: 0, tiles: 0, laps: 0 };
    this.lastCleared = null;

    this.effects.setTheme(song.hue, song.hue2);
    this.effects.setEnergy(0);
    this.effects.setBar(this.barZone());
    this.effects.banner('Get ready', 'Tap each tile as it reaches the bar');

    this.sync(now);
    this.fillAbove();
    this.refreshTargets();
    this.draw();

    this.setState({
      status: 'playing',
      score: 0,
      speedMultiplier: 1,
      highScore: getBest(song.id),
      songId: song.id,
      progress: 0,
      combo: 0,
      comboMultiplier: 1,
      lap: 0,
      paused: false,
    });
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Abandon the current run and go back to the song list. */
  quit(): void {
    cancelAnimationFrame(this.rafId);
    this.audio.stopSong();
    this.renderer.clear();
    this.tiles = [];
    this.effects.setBar(null);
    this.effects.setEnergy(0);
    this.setState({
      status: 'menu',
      score: 0,
      speedMultiplier: 1,
      progress: 0,
      combo: 0,
      comboMultiplier: 1,
      lap: 0,
      paused: false,
    });
  }

  /** Freeze the song clock (and the music with it). */
  pause(): void {
    if (this.state.status !== 'playing' || this.state.paused) return;
    this.audio.suspend();
    this.setState({ paused: true });
  }

  resume(): void {
    if (!this.state.paused) return;
    this.audio.resume();
    this.setState({ paused: false });
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.audio.stopSong();
    this.renderer.clear();
  }

  /**
   * A finger (or key) went down in `lane`. It goes to the tile in that lane belonging to the
   * next beat, and is graded by how close it is to the moment that tile reaches the bar.
   * `key` identifies the pointer so a hold can be released later.
   */
  press(lane: number, key: string): void {
    if (this.state.status !== 'playing' || this.state.paused) return;
    const now = this.audio.now();
    this.sync(now);
    const beat = this.targetBeat();
    if (beat < 0) return;

    const group = this.tiles.filter((t) => t.beat === beat);
    // The next tile isn't on screen yet, so there's nothing to aim at: ignore the press.
    if (!group.some((t) => this.reachable(t))) return;

    const tile = group.find((t) => t.lane === lane);
    if (!tile) {
      // A stray repeat on a lane cleared a moment ago isn't fatal; anything else is a blank tap.
      const last = this.lastCleared;
      if (last && last.lane === lane && now - last.time < DOUBLE_TAP_GUARD) return;
      this.endGame({ kind: 'wrong', lane, rowY: headTop(group[0]) });
      return;
    }
    if (this.isPressable(tile)) this.hit(tile, key, now);
  }

  /** A finger (or key) came up. Letting go of a hold tile too early ends the game. */
  release(key: string): void {
    if (this.state.status !== 'playing' || this.state.paused) return;
    const tile = this.tiles.find((t) => t.hold?.phase === 'holding' && t.hold.pointer === key);
    if (!tile?.hold) return;
    if (this.audio.now() >= tile.hold.end - HOLD_RELEASE_TOLERANCE) this.completeHold(tile);
    else this.endGame({ kind: 'released', tile });
  }

  private frame = (): void => {
    if (this.state.status !== 'playing') return;
    if (!this.state.paused) {
      this.update(this.audio.now());
      if (this.state.status !== 'playing') return;
      this.draw();
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  private update(now: number): void {
    this.checkLap(now);
    this.scheduleNotes(now);
    this.sync(now);

    for (const tile of this.tiles) {
      const hold = tile.hold;
      if (hold?.phase !== 'holding') continue;
      if (now >= hold.end - HOLD_RELEASE_TOLERANCE) {
        this.completeHold(tile);
      } else {
        this.renderer.setHoldProgress(tile.id, this.holdProgress(tile));
        this.effects.stream(laneCenter(tile.lane), BAR_Y);
      }
    }

    // A beat is missed once its tiles are too late to tap and still untouched.
    const beat = this.targetBeat();
    const missed = this.tiles.filter(
      (t) => t.beat === beat && !t.isHit && t.hold?.phase !== 'holding' && now - t.time > MISS_AFTER,
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

  /** The song just finished a lap: everything gets faster. */
  private checkLap(now: number): void {
    const timeline = this.timeline;
    if (!timeline) return;
    const lap = timeline.lapAt(now);
    if (lap === this.lap) return;

    this.lap = lap;
    this.stats.laps = lap;
    const speedMultiplier = Math.round(timeline.speedFactor(lap) * 100) / 100;
    this.effects.setBar(this.barZone());
    this.effects.banner(`Lap ${lap + 1}`, `Speed ×${speedMultiplier.toFixed(2)}`);
    this.effects.pulse(1);
    this.effects.setEnergy(this.energy());
    this.audio.playLevelUp();
    this.setState({ lap, speedMultiplier });
  }

  /** Hand the music for upcoming beats to the audio clock a little ahead of time. */
  private scheduleNotes(now: number): void {
    const { song, timeline } = this;
    if (!song || !timeline) return;
    // Tempo grows geometrically, so the arrival times of *all* future laps converge on a finite
    // moment. The cap keeps a huge clock jump from spinning here forever.
    for (let scheduled = 0; scheduled < MAX_NOTES_PER_FRAME; scheduled++) {
      const { lap, index } = this.locate(this.noteCursor);
      const spec = song.beats[index];
      const at = timeline.arrival(lap, this.beatStarts[index]);
      if (at > now + NOTE_LOOKAHEAD) return;

      const hold = spec.type === 'hold' ? spec.rows / timeline.rate(lap) : undefined;
      const freqs = spec.type === 'double' ? spec.freqs : [spec.freq];
      for (const freq of freqs) this.audio.schedule(freq, at, hold === undefined ? undefined : { hold });
      this.noteCursor++;
    }
  }

  private hit(tile: Tile, key: string, now: number): void {
    const { judgment, early } = judge(now - tile.time);
    const multiplier = comboMultiplier(this.combo);
    const points = POINTS[judgment] * multiplier;

    this.combo = judgment === 'perfect' ? this.combo + 1 : 0;
    this.stats[judgment]++;
    this.stats.tiles++;
    this.stats.maxChain = Math.max(this.stats.maxChain, this.combo);
    this.lastCleared = { lane: tile.lane, time: now };

    if (tile.kind === 'tap') {
      tile.isHit = true;
      this.renderer.markHit(tile.id);
    } else if (tile.hold) {
      tile.hold.phase = 'holding';
      tile.hold.pointer = key;
      this.renderer.markHolding(tile.id);
    }

    const x = laneCenter(tile.lane);
    this.effects.hit(x, bottomEdge(tile) - TILE_HEIGHT / 2, tile.lane, judgment);
    const direction = judgment === 'perfect' ? '' : ` ${early ? 'EARLY' : 'LATE'}`;
    this.effects.popup(JUDGMENT_LABEL[judgment], x, BAR_Y - 12, { sub: `+${points}${direction}`, judgment });
    if (comboMultiplier(this.combo) > multiplier) {
      this.effects.popup(`×${comboMultiplier(this.combo)}`, 50, 46, { sub: 'CHAIN', judgment: 'perfect' });
      this.effects.setEnergy(this.energy());
    }
    this.award(points);
  }

  private completeHold(tile: Tile): void {
    const hold = tile.hold;
    if (hold?.phase !== 'holding') return;
    hold.phase = 'done';
    hold.pointer = null;
    tile.isHit = true;
    this.renderer.markDone(tile.id);

    const bonus = HOLD_BONUS * comboMultiplier(this.combo);
    const x = laneCenter(tile.lane);
    this.effects.hit(x, BAR_Y, tile.lane, 'perfect');
    this.effects.popup('HOLD', x, BAR_Y - 12, { sub: `+${bonus}`, judgment: 'perfect' });
    this.award(bonus);
  }

  private award(points: number): void {
    this.refreshTargets();
    this.setState({
      score: this.state.score + points,
      combo: this.combo,
      comboMultiplier: comboMultiplier(this.combo),
      progress: this.progress(),
    });
  }

  private endGame(failure: Failure): void {
    if (this.state.status !== 'playing') return;
    cancelAnimationFrame(this.rafId);
    this.audio.stopSong();

    let x = 50;
    let y = BAR_Y;
    if (failure.kind === 'miss') {
      // Slide the board back so the missed tiles sit on the bar, and light them up red.
      const shift = Math.max(0, bottomEdge(failure.tiles[0]) - BAR_Y);
      for (const tile of this.tiles) tile.yPos -= shift;
      for (const tile of failure.tiles) this.renderer.markMiss(tile.id);
      this.renderer.enableSettling();
      this.draw();
      x = laneCenter(failure.tiles[0].lane);
    } else if (failure.kind === 'released') {
      this.renderer.markMiss(failure.tile.id);
      x = laneCenter(failure.tile.lane);
    } else {
      this.renderer.showError(failure.lane, failure.rowY);
      x = laneCenter(failure.lane);
      y = failure.rowY + TILE_HEIGHT / 2;
    }
    this.audio.playError();
    this.effects.fail(x, y);

    const { score, songId } = this.state;
    const { stats, isNewBest } = recordRun(songId, { score, maxChain: this.stats.maxChain, laps: this.lap });
    this.setState({ status: 'gameover', highScore: stats.best, combo: 0, comboMultiplier: 1 });
    this.onGameOver?.({ score, isNewBest, songId, stats: { ...this.stats, laps: this.lap } });
  }

  /** The lowest beat that still has an uncleared tile, or -1. */
  private targetBeat(): number {
    return this.tiles.find((t) => !t.isHit)?.beat ?? -1;
  }

  private isPressable(tile: Tile): boolean {
    return !tile.isHit && tile.hold?.phase !== 'holding';
  }

  /** Whether a tile's head is far enough on screen to be a fair target. */
  private reachable(tile: Tile): boolean {
    return bottomEdge(tile) - TILE_HEIGHT / 2 > 0;
  }

  private refreshTargets(): void {
    const beat = this.targetBeat();
    for (const tile of this.tiles) this.renderer.setTarget(tile.id, tile.beat === beat && !tile.isHit);
  }

  /** Fraction (0–1) of a held tile that has flowed past the bar. */
  private holdProgress(tile: Tile): number {
    const length = tile.rows * TILE_HEIGHT;
    return Math.max(0, Math.min(1, (bottomEdge(tile) - BAR_Y) / length));
  }

  /** How far through the current lap of the song, 0–1. */
  private progress(): number {
    return this.scroll <= 0 ? 0 : (this.scroll % this.rowsPerLap) / this.rowsPerLap;
  }

  private energy(): number {
    return Math.min(1, this.lap * 0.25 + (comboMultiplier(this.combo) - 1) * 0.06);
  }

  /** The bar's timing zones, sized to what the current speed makes of the timing windows. */
  private barZone(): BarZone {
    const song = this.song;
    const speed = song && this.timeline ? song.speed * this.timeline.speedFactor(this.lap) : 40;
    return { y: BAR_Y, perfect: Math.min(20, PERFECT_WINDOW * speed), good: Math.min(30, GOOD_WINDOW * speed) };
  }

  private locate(beat: number): { lap: number; index: number } {
    const count = this.song?.beats.length ?? 1;
    return { lap: Math.floor(beat / count), index: beat % count };
  }

  /** Top edge of a tile for the current scroll position. */
  private tileTop(tile: Tile): number {
    return BAR_Y - (tile.start - this.scroll) * TILE_HEIGHT - tile.rows * TILE_HEIGHT;
  }

  /** Place every tile for song time `now`. */
  private sync(now: number): void {
    if (!this.timeline) return;
    this.scroll = this.timeline.rowsAt(now);
    for (const tile of this.tiles) tile.yPos = this.tileTop(tile);
  }

  /** Lay out beats until the board is covered plus one row above the top. Returns whether any spawned. */
  private fillAbove(): boolean {
    let spawned = false;
    for (;;) {
      const last = this.tiles[this.tiles.length - 1];
      if (last && last.yPos <= -TILE_HEIGHT) return spawned;
      this.spawnBeat(this.spawnCursor++);
      spawned = true;
    }
  }

  private spawnBeat(beat: number): void {
    const { song, timeline } = this;
    if (!song || !timeline) return;
    const { lap, index } = this.locate(beat);
    const spec = song.beats[index];
    const row = this.beatStarts[index];
    const start = lap * this.rowsPerLap + row;
    const time = timeline.arrival(lap, row);

    if (spec.type === 'double') {
      // Exactly one lane between the two tiles: lanes 0 & 2, or 1 & 3.
      const lanes = Math.random() < 0.5 ? [0, 2] : [1, 3];
      lanes.forEach((lane, i) =>
        this.addTile({ beat, lane, rows: 1, kind: 'tap', freq: spec.freqs[i], start, time, end: time }, i === 0),
      );
      return;
    }
    const rows = spec.type === 'hold' ? spec.rows : 1;
    const end = time + (rows > 1 ? rows / timeline.rate(lap) : 0);
    const lane = Math.floor(Math.random() * LANES);
    this.addTile({ beat, lane, rows, kind: spec.type, freq: spec.freq, start, time, end });
  }

  private addTile(
    spec: Pick<Tile, 'beat' | 'lane' | 'rows' | 'kind' | 'freq' | 'start' | 'time'> & { end: number },
    link = false,
  ): void {
    const tile: Tile = {
      id: `tile-${this.nextId++}`,
      lane: spec.lane,
      yPos: 0,
      isHit: false,
      kind: spec.kind,
      rows: spec.rows,
      beat: spec.beat,
      freq: spec.freq,
      start: spec.start,
      time: spec.time,
      hold: spec.kind === 'hold' ? { phase: 'pending', pointer: null, end: spec.end } : null,
    };
    tile.yPos = this.tileTop(tile);
    this.tiles.push(tile);
    this.renderer.add(tile, { link });
  }

  private draw(): void {
    for (const tile of this.tiles) this.renderer.draw(tile);
  }

  private setState(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }
}
