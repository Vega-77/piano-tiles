import { LANES } from '../config';
import type { Judgment } from '../types';

/** The timing bar: `y` is its centre; `perfect` and `good` are half-heights of each zone. All percent of board height. */
export interface BarZone {
  y: number;
  perfect: number;
  good: number;
}

/** What the engine needs from the visual-effects layer, so tests can swap in a no-op. */
export interface Fx {
  setTheme(hue: number, hue2: number): void;
  /** 0–1: how intense the background looks (rises as the game speeds up). */
  setEnergy(energy: number): void;
  /** Show the timing bar, or hide it with null. */
  setBar(bar: BarZone | null): void;
  /** A tile was tapped: its head is at (x, y), both percent of board size. */
  hit(x: number, y: number, lane: number, judgment: Judgment): void;
  popup(text: string, x: number, y: number, options?: { sub?: string; judgment?: Judgment }): void;
  /** Big centred text that fades out, e.g. "Get ready" or "Lap 2". */
  banner(text: string, sub?: string): void;
  /** One big count-in number ("4", "3", …) that pops and fades; a new one replaces the last. */
  count(text: string): void;
  /** Sparks rising from a finger holding a hold tile; call every frame. */
  stream(x: number, y: number): void;
  fail(x: number, y: number): void;
  /** Flash the background, e.g. on a new lap. */
  pulse(strength?: number): void;
}

export const noopFx: Fx = {
  setTheme() {},
  setEnergy() {},
  setBar() {},
  hit() {},
  popup() {},
  banner() {},
  count() {},
  stream() {},
  fail() {},
  pulse() {},
};

const TAU = Math.PI * 2;
/** The background is soft, so render it at a fraction of the size and let CSS scale it up. */
const BG_SCALE = 0.5;
const MAX_PARTICLES = 320;
const GLYPHS = ['♪', '♫', '♩', '♬'];
const BANNER_SECONDS = 1.7;
const COUNT_SECONDS = 0.6;

const JUDGMENT_HUE: Record<Judgment, number> = { perfect: 48, good: 160, ok: 215 };

const BLOBS = [
  { sx: 0.11, sy: 0.09, px: 0, py: 1, radius: 0.7, alpha: 0.24, shift: 0 },
  { sx: 0.07, sy: 0.13, px: 2, py: 0.5, radius: 0.6, alpha: 0.2, shift: 35 },
  { sx: 0.13, sy: 0.06, px: 4, py: 2.5, radius: 0.55, alpha: 0.18, shift: -35 },
  { sx: 0.05, sy: 0.1, px: 1, py: 4, radius: 0.8, alpha: 0.14, shift: 70 },
];

interface Particle { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; hue: number }
interface Ripple { x: number; y: number; age: number; hue: number }
interface Popup { text: string; sub: string; x: number; y: number; age: number; hue: number }
interface Banner { text: string; sub: string; age: number }
interface Countdown { text: string; age: number }
interface Star { x: number; y: number; z: number; phase: number }
interface Glyph { x: number; y: number; speed: number; sway: number; char: string; size: number; phase: number }

const rand = (min: number, max: number) => min + Math.random() * (max - min);
/** Shortest signed distance between two hues on the colour wheel. */
const hueDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

/**
 * Canvas visuals, driven by their own rAF loop: an animated backdrop behind the whole page
 * and a particle layer above the tiles. None of it goes through React.
 */
export class Effects implements Fx {
  private readonly bg: HTMLCanvasElement;
  private readonly fx: HTMLCanvasElement;
  private readonly bgCtx: CanvasRenderingContext2D | null;
  private readonly fxCtx: CanvasRenderingContext2D | null;
  private readonly shakeEl: HTMLElement | null;
  private readonly reducedMotion: boolean;
  private observer: ResizeObserver | null = null;
  private rafId = 0;
  private last = 0;
  private time = 0;
  private fxScale = 1;

  private hue = 210;
  private hue2 = 270;
  private targetHue = 210;
  private targetHue2 = 270;
  private energy = 0;
  private targetEnergy = 0;
  private pulseLevel = 0;
  private failLevel = 0;
  private shakeLevel = 0;
  private bar: BarZone | null = null;
  private readonly beams: number[] = new Array<number>(LANES).fill(0);
  private readonly barFlash: number[] = new Array<number>(LANES).fill(0);
  private readonly barHue: number[] = new Array<number>(LANES).fill(48);

  private particles: Particle[] = [];
  private ripples: Ripple[] = [];
  private popups: Popup[] = [];
  private banners: Banner[] = [];
  private countdown: Countdown | null = null;
  private readonly stars: Star[] = Array.from({ length: 90 }, () => ({
    x: Math.random(), y: Math.random(), z: rand(0.2, 1), phase: rand(0, TAU),
  }));
  private readonly glyphs: Glyph[] = Array.from({ length: 9 }, () => ({
    x: Math.random(), y: Math.random(), speed: rand(0.01, 0.03), sway: rand(0.02, 0.05),
    char: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], size: rand(16, 34), phase: rand(0, TAU),
  }));

  constructor(bg: HTMLCanvasElement, fx: HTMLCanvasElement, shakeEl: HTMLElement | null = null) {
    this.bg = bg;
    this.fx = fx;
    this.bgCtx = bg.getContext('2d');
    this.fxCtx = fx.getContext('2d');
    this.shakeEl = shakeEl;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  start(): void {
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.bg);
      this.observer.observe(this.fx);
    }
    this.rafId = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.observer?.disconnect();
    if (this.shakeEl) this.shakeEl.style.transform = '';
  }

  setTheme(hue: number, hue2: number): void {
    this.targetHue = hue;
    this.targetHue2 = hue2;
  }

  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy));
  }

  setBar(bar: BarZone | null): void {
    this.bar = bar;
  }

  pulse(strength = 0.5): void {
    this.pulseLevel = Math.min(1, this.pulseLevel + strength);
  }

  hit(x: number, y: number, lane: number, judgment: Judgment): void {
    const { width, height } = this.fxSize();
    const px = (x / 100) * width;
    const py = (y / 100) * height;
    const hue = judgment === 'good' ? this.hue : JUDGMENT_HUE[judgment];
    const count = judgment === 'perfect' ? 24 : judgment === 'good' ? 14 : 6;
    this.burst(px, py, hue, this.reducedMotion ? Math.ceil(count / 3) : count);
    this.ripples.push({ x: px, y: py, age: 0, hue: judgment === 'perfect' ? 48 : this.hue2 });
    this.beams[lane] = judgment === 'ok' ? 0.4 : 1;
    this.barFlash[lane] = 1;
    this.barHue[lane] = hue;
    this.pulse(judgment === 'perfect' ? 0.4 : 0.2);
  }

  popup(text: string, x: number, y: number, options: { sub?: string; judgment?: Judgment } = {}): void {
    const { width, height } = this.fxSize();
    const hue = options.judgment === undefined ? this.hue : options.judgment === 'good' ? this.hue : JUDGMENT_HUE[options.judgment];
    this.popups.push({ text, sub: options.sub ?? '', x: (x / 100) * width, y: (y / 100) * height, age: 0, hue });
  }

  banner(text: string, sub = ''): void {
    this.banners.push({ text, sub, age: 0 });
  }

  count(text: string): void {
    this.countdown = { text, age: 0 };
    this.pulse(0.15);
  }

  stream(x: number, y: number): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const { width, height } = this.fxSize();
    this.particles.push({
      x: (x / 100) * width + rand(-16, 16), y: (y / 100) * height,
      vx: rand(-30, 30), vy: rand(-240, -90), age: 0, life: rand(0.35, 0.7), size: rand(1.5, 3), hue: 48,
    });
  }

  fail(x: number, y: number): void {
    const { width, height } = this.fxSize();
    this.burst((x / 100) * width, (y / 100) * height, 0, this.reducedMotion ? 8 : 34);
    this.failLevel = 1;
    this.pulse(0.6);
    if (!this.reducedMotion) this.shakeLevel = 1;
  }

  private fxSize(): { width: number; height: number } {
    return { width: this.fx.clientWidth, height: this.fx.clientHeight };
  }

  private burst(x: number, y: number, hue: number, count: number): void {
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const angle = rand(0, TAU);
      const speed = rand(70, 300);
      this.particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 60,
        age: 0, life: rand(0.35, 0.85), size: rand(1.5, 3.8), hue: hue + rand(-18, 18),
      });
    }
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.bg.width = Math.max(1, Math.round(this.bg.clientWidth * BG_SCALE));
    this.bg.height = Math.max(1, Math.round(this.bg.clientHeight * BG_SCALE));
    this.fx.width = Math.max(1, Math.round(this.fx.clientWidth * dpr));
    this.fx.height = Math.max(1, Math.round(this.fx.clientHeight * dpr));
    this.fxScale = dpr;
  }

  private frame = (now: number): void => {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0;
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.drawBackground();
    this.drawFx();
    this.applyShake();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    const ease = Math.min(1, dt * 3);
    this.hue += hueDelta(this.hue, this.targetHue) * ease;
    this.hue2 += hueDelta(this.hue2, this.targetHue2) * ease;
    this.energy += (this.targetEnergy - this.energy) * ease;
    this.pulseLevel = Math.max(0, this.pulseLevel - dt * 1.8);
    this.failLevel = Math.max(0, this.failLevel - dt * 2.2);
    this.shakeLevel = Math.max(0, this.shakeLevel - dt * 2.6);
    for (let i = 0; i < this.beams.length; i++) {
      this.beams[i] = Math.max(0, this.beams[i] - dt * 3.2);
      this.barFlash[i] = Math.max(0, this.barFlash[i] - dt * 4);
    }

    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 420 * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < 0.6);
    for (const p of this.popups) p.age += dt;
    this.popups = this.popups.filter((p) => p.age < 0.9);
    for (const b of this.banners) b.age += dt;
    this.banners = this.banners.filter((b) => b.age < BANNER_SECONDS);
    if (this.countdown) {
      this.countdown.age += dt;
      if (this.countdown.age >= COUNT_SECONDS) this.countdown = null;
    }

    if (this.reducedMotion) return;
    const drift = 1 + this.energy * 4;
    for (const s of this.stars) {
      s.y += dt * (0.02 + 0.1 * s.z) * drift;
      if (s.y > 1) { s.y -= 1; s.x = Math.random(); }
    }
    for (const g of this.glyphs) {
      g.y -= dt * g.speed * (1 + this.energy * 2);
      if (g.y < -0.1) { g.y = 1.1; g.x = Math.random(); }
    }
  }

  private drawBackground(): void {
    const ctx = this.bgCtx;
    const w = this.bg.width;
    const h = this.bg.height;
    if (!ctx || w < 2 || h < 2) return;
    const { hue, hue2, energy, pulseLevel, time } = this;

    ctx.globalCompositeOperation = 'source-over';
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, `hsl(${hue} 55% 10%)`);
    sky.addColorStop(1, `hsl(${hue2} 60% 4%)`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    BLOBS.forEach((blob, i) => {
      const x = w * (0.5 + 0.42 * Math.sin(time * blob.sx * 6 + blob.px));
      const y = h * (0.5 + 0.42 * Math.cos(time * blob.sy * 6 + blob.py));
      const radius = Math.max(w, h) * blob.radius;
      const shade = (i % 2 ? hue2 : hue) + blob.shift;
      const alpha = blob.alpha + energy * 0.1 + pulseLevel * 0.12;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `hsl(${shade} 90% 55% / ${alpha})`);
      glow.addColorStop(1, `hsl(${shade} 90% 55% / 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    });

    for (const s of this.stars) {
      const twinkle = 0.45 + 0.55 * Math.sin(time * 1.6 + s.phase);
      const size = 0.6 + s.z * 1.6;
      const streak = energy * s.z * h * 0.035;
      ctx.fillStyle = `hsl(${hue} 100% 90% / ${(0.15 + 0.5 * s.z) * twinkle})`;
      ctx.fillRect(s.x * w, s.y * h, size, size + streak);
    }

    ctx.globalCompositeOperation = 'source-over';
    for (const g of this.glyphs) {
      ctx.font = `${g.size}px serif`;
      ctx.fillStyle = `hsl(${hue2} 80% 85% / ${0.05 + pulseLevel * 0.06})`;
      ctx.fillText(g.char, (g.x + Math.sin(time * 0.6 + g.phase) * g.sway) * w, g.y * h);
    }
  }

  private drawFx(): void {
    const ctx = this.fxCtx;
    if (!ctx) return;
    const width = this.fx.clientWidth;
    const height = this.fx.clientHeight;
    ctx.setTransform(this.fxScale, 0, 0, this.fxScale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (width < 2 || height < 2) return;

    ctx.globalCompositeOperation = 'lighter';
    const laneWidth = width / LANES;
    this.beams.forEach((level, lane) => {
      if (level < 0.01) return;
      const beam = ctx.createLinearGradient(0, height, 0, 0);
      beam.addColorStop(0, `hsl(${this.hue} 100% 65% / ${level * 0.5})`);
      beam.addColorStop(1, `hsl(${this.hue2} 100% 65% / 0)`);
      ctx.fillStyle = beam;
      ctx.fillRect(lane * laneWidth, 0, laneWidth, height);
    });

    this.drawBar(ctx, width, height);

    for (const r of this.ripples) {
      const t = r.age / 0.6;
      ctx.strokeStyle = `hsl(${r.hue} 100% 75% / ${1 - t})`;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 12 + t * laneWidth * 0.9, 0, TAU);
      ctx.stroke();
    }

    for (const p of this.particles) {
      const t = p.age / p.life;
      ctx.fillStyle = `hsl(${p.hue} 100% 70% / ${1 - t})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, TAU);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    if (this.failLevel > 0.01) {
      ctx.fillStyle = `hsl(0 90% 55% / ${this.failLevel * 0.35})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const t = p.age / 0.9;
      const pop = 1 + Math.max(0, 0.25 - p.age) * 2;
      ctx.save();
      ctx.translate(p.x, p.y - t * 60);
      ctx.scale(pop, pop);
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'hsl(0 0% 0% / 0.55)';
      ctx.font = '900 20px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = `hsl(${p.hue} 100% 82%)`;
      ctx.fillText(p.text, 0, 0);
      if (p.sub) {
        ctx.font = '800 14px ui-sans-serif, system-ui, sans-serif';
        ctx.strokeText(p.sub, 0, 19);
        ctx.fillStyle = 'hsl(0 0% 100%)';
        ctx.fillText(p.sub, 0, 19);
      }
      ctx.restore();
    }

    for (const b of this.banners) {
      const t = b.age / BANNER_SECONDS;
      const pop = 1 + Math.max(0, 0.3 - b.age) * 1.6;
      ctx.save();
      ctx.translate(width / 2, height * 0.34);
      ctx.scale(pop, pop);
      ctx.globalAlpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'hsl(0 0% 0% / 0.55)';
      ctx.font = '900 44px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = `hsl(${this.hue} 100% 85%)`;
      ctx.fillText(b.text, 0, 0);
      if (b.sub) {
        ctx.font = '700 17px ui-sans-serif, system-ui, sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeText(b.sub, 0, 34);
        ctx.fillStyle = 'hsl(0 0% 100% / 0.95)';
        ctx.fillText(b.sub, 0, 34);
      }
      ctx.restore();
    }

    const count = this.countdown;
    if (count) {
      const t = count.age / COUNT_SECONDS;
      const pop = this.reducedMotion ? 1 : 1 + Math.max(0, 0.15 - count.age) * 5;
      ctx.save();
      ctx.translate(width / 2, height * 0.5);
      ctx.scale(pop, pop);
      ctx.globalAlpha = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'hsl(0 0% 0% / 0.55)';
      ctx.font = '900 120px ui-sans-serif, system-ui, sans-serif';
      ctx.strokeText(count.text, 0, 0);
      ctx.fillStyle = `hsl(${this.hue} 100% 88%)`;
      ctx.fillText(count.text, 0, 0);
      ctx.restore();
    }
  }

  /** The timing bar: a glowing line, a soft band per timing window, and a pad per lane that flashes on a hit. */
  private drawBar(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const bar = this.bar;
    if (!bar) return;
    const y = (bar.y / 100) * height;
    const good = (bar.good / 100) * height;
    const perfect = (bar.perfect / 100) * height;
    const laneWidth = width / LANES;

    // "Good" zone: a faint band.
    ctx.fillStyle = `hsl(${this.hue2} 100% 65% / 0.08)`;
    ctx.fillRect(0, y - good, width, good * 2);

    // "Perfect" zone: a brighter golden band that fades at its edges.
    const zone = ctx.createLinearGradient(0, y - perfect, 0, y + perfect);
    zone.addColorStop(0, 'hsl(48 100% 70% / 0)');
    zone.addColorStop(0.5, 'hsl(48 100% 70% / 0.3)');
    zone.addColorStop(1, 'hsl(48 100% 70% / 0)');
    ctx.fillStyle = zone;
    ctx.fillRect(0, y - perfect, width, perfect * 2);

    // The line itself, with a wide dim copy underneath for glow.
    ctx.fillStyle = `hsl(${this.hue} 100% 80% / 0.18)`;
    ctx.fillRect(0, y - 5, width, 10);
    ctx.fillStyle = `hsl(${this.hue} 100% 90% / 0.95)`;
    ctx.fillRect(0, y - 1, width, 2);

    // A pad in every lane that lights up when that lane is hit.
    for (let lane = 0; lane < LANES; lane++) {
      const flash = this.barFlash[lane];
      const cx = lane * laneWidth + laneWidth / 2;
      const w = laneWidth * 0.78 + flash * 14;
      const h = 12 + flash * 10;
      ctx.fillStyle =
        flash > 0.01
          ? `hsl(${this.barHue[lane]} 100% 72% / ${0.3 + 0.7 * flash})`
          : `hsl(${this.hue} 100% 80% / 0.3)`;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - w / 2, y - h / 2, w, h, h / 2);
      else ctx.rect(cx - w / 2, y - h / 2, w, h);
      ctx.fill();
    }
  }

  private applyShake(): void {
    if (!this.shakeEl) return;
    if (this.shakeLevel < 0.01) {
      if (this.shakeEl.style.transform) this.shakeEl.style.transform = '';
      return;
    }
    const amount = this.shakeLevel * this.shakeLevel * 12;
    this.shakeEl.style.transform = `translate(${rand(-amount, amount)}px, ${rand(-amount, amount)}px)`;
  }
}
