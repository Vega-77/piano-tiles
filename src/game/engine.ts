import {
  BAR_Y,
  COMBO_MAX_MULTIPLIER,
  COMBO_STEP,
  COUNT_IN_BEATS,
  DOUBLE_TAP_GUARD,
  GOOD_WINDOW,
  HOLD_TICK_POINTS,
  LANES,
  LEAD_ROWS,
  NOTE_LOOKAHEAD,
  OK_WINDOW,
  PERFECT_WINDOW,
  POINTS,
  TILE_HEIGHT,
} from '../config';
import { beatRows } from '../songs/notation';
import type { GameState, Judgment, MusicEvent, Song, Tile } from '../types';
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

/** Why a run ended. */
export type FailReason = 'miss' | 'early' | 'wrong';

export interface GameOverResult {
  score: number;
  isNewBest: boolean;
  songId: string;
  reason: FailReason;
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
  | { kind: 'early'; tile: Tile }
  | { kind: 'wrong'; lane: number; rowY: number };

const JUDGMENT_LABEL: Record<Judgment, string> = { perfect: 'PERFECT', good: 'GOOD', ok: 'OK' };

/** Upper bound on rows of music handed to the audio clock in a single frame. */
const MAX_ROWS_PER_FRAME = 256;

/**
 * A recorded song is handed over a whole lap at a time, this far ahead (seconds). It only has to
 * outrun a slow frame, since the audio clock does the timing.
 */
const RECORDING_LOOKAHEAD = 1;
/** Laps of a recording that will ever be scheduled: by lap 30 it is thousands of times too fast to play. */
const MAX_RECORDED_LAPS = 30;

// A count-in of soft ticks over the lead-in, so the music starts before the first tile arrives.
// Later laps count in the same way, one tick a beat, after their rest.
const COUNT_IN_FIRST: readonly MusicEvent[] = [{ kind: 'kick' }, { kind: 'hat' }];
const COUNT_IN: readonly MusicEvent[] = [{ kind: 'hat', soft: true }];
const SILENCE: readonly MusicEvent[] = [];

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

/**
 * Grade a tap by how far (seconds) it was from the moment its tile was centred on the bar.
 * Negative = early. Further away than the OK window there is no grade: the tap doesn't line up.
 */
export function judge(delta: number): { judgment: Judgment | null; early: boolean } {
  const distance = Math.abs(delta);
  const judgment =
    distance <= PERFECT_WINDOW ? 'perfect' : distance <= GOOD_WINDOW ? 'good' : distance <= OK_WINDOW ? 'ok' : null;
  return { judgment, early: delta < 0 };
}

const laneCenter = (lane: number): number => (lane + 0.5) * (100 / LANES);
const bottomEdge = (tile: Tile): number => tile.yPos + tile.rows * TILE_HEIGHT;
/** The middle of a tile's lowest row: the part that lines up with the bar. */
const headCenter = (tile: Tile): number => bottomEdge(tile) - TILE_HEIGHT / 2;

/**
 * The game loop and rules, kept outside React.
 *
 * One clock rules everything: the audio clock. A `Timeline` says when each row of the song
 * reaches the timing bar; tiles are drawn wherever that puts them, and the whole backing track
 * (melody, drums, bass, chords) is scheduled ahead of time for the same moments. So the tiles are
 * always on the beat, the song plays on its own whether or not you tap, and a tap is graded purely
 * by how close it landed to the moment its tile was centred on the bar. Finishing the song
 * speeds the whole thing up.
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
  /** Next beat to lay out, counting across laps. */
  private spawnCursor = 0;
  /** Next row to schedule music for: a lap, and a row in it. Negative rows are the count-in and rest. */
  private musicCursor = { lap: 0, row: -LEAD_ROWS };
  /** How many count-in numbers the current lap has shown. */
  private cue = 0;
  /** Next lap of a recorded song to hand to the audio clock. */
  private recordedLap = 0;
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
      row += beatRows(beat);
      return start;
    });
    this.rowsPerLap = row;
    const baseRate = song.speed / TILE_HEIGHT;
    const now = this.audio.now();

    this.song = song;
    this.timeline = new Timeline(
      baseRate,
      this.rowsPerLap,
      now + LEAD_ROWS / baseRate,
      this.countInRows(song),
    );
    this.tiles = [];
    this.spawnCursor = 0;
    this.musicCursor = { lap: 0, row: -LEAD_ROWS };
    this.cue = 0;
    this.recordedLap = 0;
    this.lap = 0;
    this.combo = 0;
    this.stats = { perfect: 0, good: 0, ok: 0, maxChain: 0, tiles: 0, laps: 0 };
    this.lastCleared = null;

    this.effects.setTheme(song.hue, song.hue2);
    this.effects.setEnergy(0);
    this.effects.setBar(this.barZone());
    this.effects.banner('Get ready', 'Tap each tile as it lines up with the bar');

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
   * next beat, and is graded by how close it is to the moment that tile is centred on the bar.
   * Tap so early (or so late) that the tile doesn't line up with the bar, and the game is over.
   * `key` identifies the pointer so a hold can be released later.
   */
  press(lane: number, key: string): void {
    if (this.state.status !== 'playing' || this.state.paused) return;
    const now = this.audio.now();
    this.sync(now);
    const pending = this.pendingBeats();
    if (pending.length === 0) return;

    let group = this.tilesOfBeat(pending[0]);
    // A hold that is still being held doesn't block what comes next: tapping the next tile
    // lets go of the hold (keeping the points it has earned) and counts as that tile's tap.
    // That only applies once the next tile is actually due; a press any earlier than that is
    // not "moving on", so it falls through and is treated like any other press.
    if (pending.length > 1 && group.every((t) => t.hold?.phase === 'holding')) {
      const next = this.tilesOfBeat(pending[1]);
      const due = now >= next[0].time - OK_WINDOW;
      if (due && next.some((t) => t.lane === lane) && next.some((t) => this.reachable(t))) {
        for (const held of group) {
          this.payTicks(held, now);
          this.finishHold(held, false);
        }
        group = next;
      }
    }

    // The next tile isn't on screen yet, so there's nothing to aim at: ignore the press.
    if (!group.some((t) => this.reachable(t))) return;

    const tile = group.find((t) => t.lane === lane);
    if (!tile) {
      // A stray repeat on a lane cleared a moment ago isn't fatal; anything else is a blank tap.
      const last = this.lastCleared;
      if (last && last.lane === lane && now - last.time < DOUBLE_TAP_GUARD) return;
      this.endGame({ kind: 'wrong', lane, rowY: group[0].yPos + (group[0].rows - 1) * TILE_HEIGHT });
      return;
    }
    if (!this.isPressable(tile)) return;

    const delta = now - tile.time;
    const { judgment, early } = judge(delta);
    if (!judgment) {
      this.endGame(delta < 0 ? { kind: 'early', tile } : { kind: 'miss', tiles: [tile] });
      return;
    }
    this.hit(tile, key, now, judgment, early);
  }

  /** A finger (or key) came up. Letting go of a hold tile just stops it paying out. */
  release(key: string): void {
    if (this.state.status !== 'playing' || this.state.paused) return;
    const tile = this.tiles.find((t) => t.hold?.phase === 'holding' && t.hold.pointer === key);
    if (!tile?.hold) return;
    const now = this.audio.now();
    this.payTicks(tile, now);
    this.finishHold(tile, now >= tile.hold.end);
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
    this.showCount(now);
    this.scheduleMusic(now);
    this.scheduleRecording(now);
    this.sync(now);

    for (const tile of this.tiles) {
      const hold = tile.hold;
      if (hold?.phase !== 'holding') continue;
      this.payTicks(tile, now);
      if (now >= hold.end) {
        this.finishHold(tile, true);
      } else {
        this.renderer.setHoldProgress(tile.id, this.holdProgress(tile));
        this.effects.stream(laneCenter(tile.lane), BAR_Y);
      }
    }

    // A beat is missed once its tiles are too late to tap and still untouched.
    const beat = this.targetBeat();
    const missed = this.tiles.filter(
      (t) => t.beat === beat && !t.isHit && t.hold?.phase !== 'holding' && now - t.time > OK_WINDOW,
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

  /** Rows of count-in in front of each later lap: a few beats of the song. */
  private countInRows(song: Song): number {
    return COUNT_IN_BEATS * song.rowsPerBeat;
  }

  /** Rows the music cursor passes before row 0 of a lap: the lead-in, or a later lap's rest and count-in. */
  private leadRows(lap: number): number {
    return lap === 0 ? LEAD_ROWS : (this.timeline?.gapRows(lap) ?? 0);
  }

  /**
   * The song just finished a lap: everything gets faster, and the board goes quiet for a rest
   * and a count-in before the next lap's first tile.
   */
  private checkLap(now: number): void {
    const timeline = this.timeline;
    if (!timeline) return;
    const lap = timeline.lapAt(now);
    if (lap === this.lap) return;

    this.lap = lap;
    this.cue = 0;
    this.stats.laps = lap;
    const speedMultiplier = Math.round(timeline.speedFactor(lap) * 100) / 100;
    this.effects.setBar(this.barZone());
    this.effects.banner(`Lap ${lap + 1}`, `Speed ×${speedMultiplier.toFixed(2)}`);
    this.effects.pulse(1);
    this.effects.setEnergy(this.energy());
    this.audio.playLevelUp();
    this.setState({ lap, speedMultiplier, progress: 0 });
  }

  /** Put the count-in number on screen as each of the next lap's count-in beats comes due. */
  private showCount(now: number): void {
    const { song, timeline } = this;
    if (!song || !timeline || this.lap === 0) return;
    const first = -this.countInRows(song);
    let shown = -1;
    while (this.cue < COUNT_IN_BEATS && now >= timeline.arrival(this.lap, first + this.cue * song.rowsPerBeat)) {
      shown = this.cue++;
    }
    if (shown >= 0) this.effects.count(String(COUNT_IN_BEATS - shown));
  }

  /** What the synth plays on a row: the count-in ticks, nothing through a rest, then the song's own track. */
  private eventsAt(song: Song, lap: number, row: number): readonly MusicEvent[] {
    if (row >= 0) return song.track[row];
    if (lap === 0) return row === -LEAD_ROWS ? COUNT_IN_FIRST : COUNT_IN;
    const into = row + this.countInRows(song);
    if (into < 0 || into % song.rowsPerBeat !== 0) return SILENCE;
    return into === 0 ? COUNT_IN_FIRST : COUNT_IN;
  }

  /**
   * Hand the backing track to the audio clock a little ahead of time, one row at a time: the
   * count-in first, then every row of every lap, drums and bass and chords included, and each
   * later lap's rest and count-in.
   */
  private scheduleMusic(now: number): void {
    const { song, timeline } = this;
    if (!song || !timeline) return;
    // The cap keeps a huge clock jump from spinning here forever.
    for (let rows = 0; rows < MAX_ROWS_PER_FRAME; rows++) {
      const { lap, row } = this.musicCursor;
      // A recorded song brings its own band: only the count-ins are synthesised, so once a lap's
      // rows begin there is nothing to hand over until the next lap's rest.
      if (row >= 0 && song.recording) {
        this.musicCursor = { lap: lap + 1, row: -this.leadRows(lap + 1) };
        continue;
      }
      const at = timeline.arrival(lap, row);
      if (at > now + NOTE_LOOKAHEAD) return;

      const secondsPerRow = 1 / timeline.rate(lap);
      for (const event of this.eventsAt(song, lap, row)) this.audio.schedule(event, at, secondsPerRow);
      this.musicCursor =
        row + 1 >= this.rowsPerLap ? { lap: lap + 1, row: -this.leadRows(lap + 1) } : { lap, row: row + 1 };
    }
  }

  /**
   * Hand a recorded song to the audio clock, one lap at a time. Lap `n` plays the whole recording
   * `1 + LAP_SPEED_STEP * n` times faster, starting early enough that the recording's beat grid
   * (row 0 is `offset` seconds in) lands exactly where the timeline puts row 0 of that lap.
   */
  private scheduleRecording(now: number): void {
    const { song, timeline } = this;
    const recording = song?.recording;
    if (!recording || !timeline) return;
    // Laps keep getting shorter, so cap how many are handed over in one frame.
    for (let laps = 0; laps < 2 && this.recordedLap < MAX_RECORDED_LAPS; laps++) {
      const lap = this.recordedLap;
      const speed = timeline.speedFactor(lap);
      const at = timeline.lapStart(lap) - recording.offset / speed;
      if (at > now + RECORDING_LOOKAHEAD) return;
      this.audio.playRecording(recording.url, at, speed);
      this.recordedLap++;
    }
  }

  private hit(tile: Tile, key: string, now: number, judgment: Judgment, early: boolean): void {
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
      const hold = tile.hold;
      hold.phase = 'holding';
      hold.pointer = key;
      // Ticks that went by before the tile was grabbed are gone: a late grab earns less.
      const spacing = (hold.end - tile.time) / hold.totalTicks;
      hold.ticks = Math.max(0, Math.min(hold.totalTicks, Math.floor((now - tile.time) / spacing)));
      this.renderer.markHolding(tile.id);
    }

    const x = laneCenter(tile.lane);
    this.effects.hit(x, headCenter(tile), tile.lane, judgment);
    const direction = judgment === 'perfect' ? '' : ` ${early ? 'EARLY' : 'LATE'}`;
    this.effects.popup(JUDGMENT_LABEL[judgment], x, BAR_Y - 14, { sub: `+${points}${direction}`, judgment });
    if (comboMultiplier(this.combo) > multiplier) {
      this.effects.popup(`×${comboMultiplier(this.combo)}`, 50, 46, { sub: 'CHAIN', judgment: 'perfect' });
      this.effects.setEnergy(this.energy());
    }
    this.award(points);
  }

  /** Pay out every tick of a held tile that has come due by `now`. */
  private payTicks(tile: Tile, now: number): void {
    const hold = tile.hold;
    if (hold?.phase !== 'holding') return;
    const spacing = (hold.end - tile.time) / hold.totalTicks;
    while (hold.ticks < hold.totalTicks && now >= tile.time + (hold.ticks + 1) * spacing) {
      hold.ticks++;
      const points = HOLD_TICK_POINTS * comboMultiplier(this.combo);
      hold.earned += points;
      this.award(points);
    }
  }

  /**
   * A hold tile is over: it ran to its end (`natural`) or the player let go early. Either way the
   * player keeps what it paid out so far; letting go just forfeits the rest.
   */
  private finishHold(tile: Tile, natural: boolean): void {
    const hold = tile.hold;
    if (hold?.phase !== 'holding') return;
    hold.phase = 'done';
    hold.pointer = null;
    tile.isHit = true;

    const x = laneCenter(tile.lane);
    if (natural) {
      this.renderer.markDone(tile.id);
      this.effects.hit(x, BAR_Y, tile.lane, 'perfect');
    } else {
      this.renderer.markReleased(tile.id);
    }
    if (hold.earned > 0) {
      this.effects.popup(natural ? 'HOLD' : 'LET GO', x, BAR_Y - 14, {
        sub: `+${hold.earned}`,
        judgment: natural ? 'perfect' : 'ok',
      });
    }
    this.award(0);
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
      // Slide the board back so the missed tiles are centred on the bar, and light them up red.
      const shift = Math.max(0, headCenter(failure.tiles[0]) - BAR_Y);
      for (const tile of this.tiles) tile.yPos -= shift;
      for (const tile of failure.tiles) this.renderer.markMiss(tile.id);
      this.renderer.enableSettling();
      this.draw();
      x = laneCenter(failure.tiles[0].lane);
    } else if (failure.kind === 'early') {
      this.renderer.markMiss(failure.tile.id);
      x = laneCenter(failure.tile.lane);
      y = headCenter(failure.tile);
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
    this.onGameOver?.({ score, isNewBest, songId, reason: failure.kind, stats: { ...this.stats, laps: this.lap } });
  }

  /** Beats that still have an uncleared tile, lowest first. */
  private pendingBeats(): number[] {
    const beats = new Set<number>();
    for (const tile of this.tiles) if (!tile.isHit) beats.add(tile.beat);
    return [...beats].sort((a, b) => a - b);
  }

  private tilesOfBeat(beat: number): Tile[] {
    return this.tiles.filter((t) => t.beat === beat);
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
    return headCenter(tile) > 0;
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

  /** How far through the current lap of the song, 0–1 (0 through a rest and count-in). */
  private progress(): number {
    if (!this.timeline) return 0;
    return Math.max(0, Math.min(1, (this.scroll - this.timeline.origin(this.lap)) / this.rowsPerLap));
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

  /** Y (percent of board height) of the bottom edge of row `row`, for the current scroll position. */
  private edgeY(row: number): number {
    return BAR_Y + TILE_HEIGHT / 2 - (row - this.scroll) * TILE_HEIGHT;
  }

  /** Top edge of a tile for the current scroll position. */
  private tileTop(tile: Tile): number {
    return this.edgeY(tile.start) - tile.rows * TILE_HEIGHT;
  }

  /** Place every tile for song time `now`. */
  private sync(now: number): void {
    if (!this.timeline) return;
    this.scroll = this.timeline.rowsAt(now);
    for (const tile of this.tiles) tile.yPos = this.tileTop(tile);
  }

  /** Row (in the scroll) where a beat starts, counting across laps and the rests between them. */
  private beatStart(beat: number): number {
    const count = this.beatStarts.length;
    return (this.timeline?.origin(Math.floor(beat / count)) ?? 0) + this.beatStarts[beat % count];
  }

  /** Lay out beats until the board is covered plus one row above the top. Returns whether any tile spawned. */
  private fillAbove(): boolean {
    let spawned = false;
    while (this.edgeY(this.beatStart(this.spawnCursor)) > -TILE_HEIGHT) {
      if (this.spawnBeat(this.spawnCursor++)) spawned = true;
    }
    return spawned;
  }

  /** Lay out one beat. Gaps take up rows but have no tile. Returns whether it made any tiles. */
  private spawnBeat(beat: number): boolean {
    const { song, timeline } = this;
    if (!song || !timeline) return false;
    const count = song.beats.length;
    const lap = Math.floor(beat / count);
    const index = beat % count;
    const spec = song.beats[index];
    const row = this.beatStarts[index];
    const start = timeline.origin(lap) + row;
    const time = timeline.arrival(lap, row);

    if (spec.type === 'rest') return false;
    if (spec.type === 'double') {
      // Exactly one lane between the two tiles: lanes 0 & 2, or 1 & 3.
      const lanes = Math.random() < 0.5 ? [0, 2] : [1, 3];
      lanes.forEach((lane, i) =>
        this.addTile({ beat, lane, rows: 1, kind: 'tap', freq: spec.freqs[i], start, time, end: time }, i === 0),
      );
      return true;
    }
    const rows = spec.type === 'hold' ? spec.rows : 1;
    // A hold is complete when its far end reaches the bar: half a row less than its length.
    const end = time + (rows - 0.5) / timeline.rate(lap);
    const lane = Math.floor(Math.random() * LANES);
    this.addTile({ beat, lane, rows, kind: spec.type, freq: spec.freq, start, time, end });
    return true;
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
      hold:
        spec.kind === 'hold'
          ? { phase: 'pending', pointer: null, end: spec.end, totalTicks: spec.rows * 2 - 1, ticks: 0, earned: 0 }
          : null,
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
