// Relative strength of each harmonic; a few decaying partials read as "piano-ish".
const PARTIALS: ReadonlyArray<readonly [multiple: number, gain: number]> = [
  [1, 1],
  [2, 0.45],
  [3, 0.2],
  [4, 0.09],
];

/** Worst-case output latency we'll compensate for, in seconds. */
const MAX_LATENCY = 0.25;

/**
 * What the engine needs from the audio layer, so tests can swap in a fake. The music is
 * scheduled ahead of time on the audio clock and plays on its own: it never reacts to taps.
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
  /** Play a note at song time `at`. A hold note is sustained for `hold` seconds. */
  schedule(frequency: number, at: number, options?: { hold?: number }): void;
  suspend(): void;
  resume(): void;
  playError(): void;
  playLevelUp(): void;
}

export class AudioEngine implements Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private songBus: GainNode | null = null;
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

  schedule(frequency: number, at: number, { hold }: { hold?: number } = {}): void {
    const { ctx, songBus } = this;
    if (!ctx || !songBus) return;
    const when = Math.max(ctx.currentTime, at + this.latency());
    this.voice(ctx, songBus, frequency, when, hold);
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

  /** Quick rising two-note chime when a new lap (and a faster tempo) begins. */
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

  /** One piano-ish note starting at audio-context time `when`. */
  private voice(ctx: AudioContext, destination: AudioNode, frequency: number, when: number, hold?: number): void {
    const sustain = hold !== undefined;
    // Ordinary notes ring out on their own for 1.6s; hold notes sustain, then release.
    const held = sustain ? Math.max(0.2, hold) : 0;
    const end = when + (sustain ? held + 0.35 : 1.6);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.exponentialRampToValueAtTime(0.9, when + 0.006);
    if (sustain) {
      envelope.gain.exponentialRampToValueAtTime(0.5, when + Math.min(0.25, held));
      envelope.gain.setValueAtTime(0.5, when + held);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + held + 0.3);
    } else {
      envelope.gain.exponentialRampToValueAtTime(0.3, when + 0.3);
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
