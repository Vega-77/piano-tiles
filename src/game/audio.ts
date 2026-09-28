import { MELODY } from './melody';

// Relative strength of each harmonic; a few decaying partials read as "piano-ish".
const PARTIALS: ReadonlyArray<readonly [multiple: number, gain: number]> = [
  [1, 1],
  [2, 0.45],
  [3, 0.2],
  [4, 0.09],
];

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

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

  /** Play the note at `index` in the melody (wraps around). */
  playNote(index: number): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;

    const frequency = MELODY[index % MELODY.length];
    const now = ctx.currentTime;
    const duration = 1.6;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.9, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.3, now + 0.3);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    // Brightness fades as the note rings out, like a struck string.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(frequency * 9, now);
    tone.frequency.exponentialRampToValueAtTime(frequency * 2, now + 0.9);

    tone.connect(envelope);
    envelope.connect(master);

    for (const [multiple, gain] of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = multiple === 1 ? 'triangle' : 'sine';
      osc.frequency.value = frequency * multiple;
      const partial = ctx.createGain();
      partial.gain.value = gain;
      osc.connect(partial);
      partial.connect(tone);
      osc.start(now);
      osc.stop(now + duration + 0.05);
      if (multiple === 1) osc.onended = () => envelope.disconnect();
    }
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
}
