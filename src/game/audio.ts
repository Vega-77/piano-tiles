import type { MusicEvent } from '../types';

// Relative strength of each harmonic of the lead; a few decaying partials read as "piano-ish".
const PARTIALS: ReadonlyArray<readonly [multiple: number, gain: number]> = [
  [1, 1],
  [2, 0.45],
  [3, 0.2],
  [4, 0.09],
];

/** Worst-case output latency we'll compensate for, in seconds. */
const MAX_LATENCY = 0.25;

/**
 * What the engine needs from the audio layer, so tests can swap in a fake. The whole song, from
 * melody to drums, is scheduled ahead of time on the audio clock and plays on its own: it never
 * reacts to taps.
 */
export interface Sound {
  unlock(): void;
  /**
   * The song clock, in seconds. It is the audio clock (adjusted for output latency, so what
   * you see lines up with what you hear) and it stands still while suspended.
   */
  now(): number;
  /** Begin a new song, silencing anything left over from the last one. */
  startSong(): void;
  /** Cut the song off. */
  stopSong(): void;
  /** Play part of the track at song time `at`. `secondsPerRow` turns row lengths into seconds. */
  schedule(event: MusicEvent, at: number, secondsPerRow: number): void;
  suspend(): void;
  resume(): void;
  playError(): void;
  playLevelUp(): void;
}

export class AudioEngine implements Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private songBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private fallbackOrigin = 0;

  /** Create/resume the AudioContext. Must be called from a user gesture (autoplay policy). */
  unlock(): void {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return;
      this.ctx = new AudioContext();
      const compressor = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(compressor);
      compressor.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  now(): number {
    const ctx = this.ctx;
    if (!ctx) {
      // No Web Audio: fall back to the page clock so the game still runs (silently).
      if (!this.fallbackOrigin) this.fallbackOrigin = performance.now();
      return (performance.now() - this.fallbackOrigin) / 1000;
    }
    return ctx.currentTime - this.latency();
  }

  startSong(): void {
    this.stopSong();
    const { ctx, master } = this;
    if (!ctx || !master) return;
    this.songBus = ctx.createGain();
    this.songBus.connect(master);
  }

  stopSong(): void {
    const { ctx, songBus } = this;
    if (!ctx || !songBus) return;
    // A short fade so cutting the song off doesn't click.
    const t = ctx.currentTime;
    songBus.gain.cancelScheduledValues(t);
    songBus.gain.setValueAtTime(songBus.gain.value, t);
    songBus.gain.linearRampToValueAtTime(0, t + 0.15);
    const old = songBus;
    window.setTimeout(() => old.disconnect(), 400);
    this.songBus = null;
  }

  schedule(event: MusicEvent, at: number, secondsPerRow: number): void {
    const { ctx, songBus } = this;
    if (!ctx || !songBus) return;
    const when = Math.max(ctx.currentTime, at + this.latency());

    switch (event.kind) {
      case 'melody':
        this.lead(ctx, songBus, event.freq, when, event.rows === undefined ? undefined : event.rows * secondsPerRow);
        break;
      case 'kick':
        this.kick(ctx, songBus, when);
        break;
      case 'snare':
        this.snare(ctx, songBus, when, event.soft ?? false);
        break;
      case 'hat':
        this.hat(ctx, songBus, when, event.soft ?? false);
        break;
      case 'bass':
        this.bass(ctx, songBus, event.freq, when, event.rows * secondsPerRow);
        break;
      case 'chord':
        this.chord(ctx, songBus, event.freqs, when, event.rows * secondsPerRow, event.pad ?? false);
        break;
    }
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /** Low descending buzz for a wrong tap or a missed tile. */
  playError(): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.4);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + 0.5);
    osc.onended = () => gain.disconnect();
  }

  /** Quick rising chime when a new lap (and a faster tempo) begins. */
  playLevelUp(): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    [880, 1318.5, 1760].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      const start = now + i * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.45);
      osc.onended = () => gain.disconnect();
    });
  }

  private latency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return Math.min(MAX_LATENCY, ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** A second of white noise, shared by the snare and hats. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  /** A burst of filtered noise. */
  private noiseHit(
    ctx: AudioContext,
    destination: AudioNode,
    when: number,
    filter: { type: BiquadFilterType; frequency: number; q?: number },
    level: number,
    decay: number,
  ): void {
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer(ctx);
    const biquad = ctx.createBiquadFilter();
    biquad.type = filter.type;
    biquad.frequency.value = filter.frequency;
    biquad.Q.value = filter.q ?? 1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + decay);
    source.connect(biquad);
    biquad.connect(gain);
    gain.connect(destination);
    source.start(when);
    source.stop(when + decay + 0.02);
    source.onended = () => gain.disconnect();
  }

  private kick(ctx: AudioContext, destination: AudioNode, when: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(42, when + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.32);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + 0.34);
    osc.onended = () => gain.disconnect();
  }

  private snare(ctx: AudioContext, destination: AudioNode, when: number, soft: boolean): void {
    this.noiseHit(ctx, destination, when, { type: 'bandpass', frequency: 1900, q: 0.7 }, soft ? 0.4 : 0.85, 0.17);
    // A short tonal body under the noise.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210, when);
    osc.frequency.exponentialRampToValueAtTime(110, when + 0.08);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(soft ? 0.12 : 0.28, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + 0.12);
    osc.onended = () => gain.disconnect();
  }

  private hat(ctx: AudioContext, destination: AudioNode, when: number, soft: boolean): void {
    this.noiseHit(ctx, destination, when, { type: 'highpass', frequency: 6000 }, soft ? 0.7 : 1.5, 0.05);
  }

  private bass(ctx: AudioContext, destination: AudioNode, frequency: number, when: number, seconds: number): void {
    const length = Math.max(0.12, seconds * 0.92);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(900, when);
    tone.frequency.exponentialRampToValueAtTime(300, when + 0.15);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.4, when + 0.012);
    gain.gain.setValueAtTime(0.36, when + length);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + length + 0.09);
    tone.connect(gain);
    gain.connect(destination);

    const end = when + length + 0.12;
    (['sawtooth', 'sine'] as const).forEach((type, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = frequency;
      const level = ctx.createGain();
      level.gain.value = i === 0 ? 0.5 : 0.55; // the sine adds weight underneath the buzzy saw
      osc.connect(level);
      level.connect(tone);
      osc.start(when);
      osc.stop(end);
      if (i === 0) osc.onended = () => gain.disconnect();
    });
  }

  private chord(
    ctx: AudioContext,
    destination: AudioNode,
    frequencies: readonly number[],
    when: number,
    seconds: number,
    pad: boolean,
  ): void {
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = pad ? 1100 : 2400;
    const gain = ctx.createGain();
    if (pad) {
      // Slow swell, sustained for the length of the chord, then a gentle release.
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.05, when + Math.min(0.3, seconds / 2));
      gain.gain.setValueAtTime(0.05, when + seconds);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + seconds + 0.45);
    } else {
      // A short stab.
      const length = Math.min(0.45, Math.max(0.1, seconds * 0.9));
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.1, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
    }
    tone.connect(gain);
    gain.connect(destination);

    const end = when + (pad ? seconds + 0.5 : Math.min(0.5, Math.max(0.15, seconds)) + 0.05);
    let first = true;
    for (const frequency of frequencies) {
      // The pad doubles each note with a slightly detuned copy for width.
      for (const detune of pad ? [-7, 7] : [0]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        osc.connect(tone);
        osc.start(when);
        osc.stop(end);
        if (first) {
          osc.onended = () => gain.disconnect();
          first = false;
        }
      }
    }
  }

  /** The piano-ish lead that plays the melody. Given `hold` seconds it sustains, then releases. */
  private lead(ctx: AudioContext, destination: AudioNode, frequency: number, when: number, hold?: number): void {
    const sustain = hold !== undefined;
    const held = sustain ? Math.max(0.2, hold) : 0;
    const end = when + (sustain ? held + 0.35 : 1.6);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(1.0, when + 0.006);
    if (sustain) {
      envelope.gain.exponentialRampToValueAtTime(0.55, when + Math.min(0.25, held));
      envelope.gain.setValueAtTime(0.55, when + held);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + held + 0.3);
    } else {
      envelope.gain.exponentialRampToValueAtTime(0.33, when + 0.3);
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    }

    // Brightness fades as the note rings out, like a struck string.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(frequency * 9, when);
    tone.frequency.exponentialRampToValueAtTime(frequency * 2, when + 0.9);

    tone.connect(envelope);
    envelope.connect(destination);

    PARTIALS.forEach(([multiple, gain], i) => {
      const osc = ctx.createOscillator();
      osc.type = multiple === 1 ? 'triangle' : 'sine';
      osc.frequency.value = frequency * multiple;
      const partial = ctx.createGain();
      partial.gain.value = gain;
      osc.connect(partial);
      partial.connect(tone);
      osc.start(when);
      osc.stop(end + 0.05);
      if (i === 0) osc.onended = () => envelope.disconnect();
    });
  }
}
