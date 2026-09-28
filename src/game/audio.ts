// Relative strength of each harmonic; a few decaying partials read as "piano-ish".
const PARTIALS: ReadonlyArray<readonly [multiple: number, gain: number]> = [
  [1, 1],
  [2, 0.45],
  [3, 0.2],
  [4, 0.09],
];

export interface NoteHandle {
  /** End a sustained note (hold tiles). No-op for ordinary notes, which decay on their own. */
  release(): void;
}

/** What the engine needs from the audio layer, so tests can swap in a fake. */
export interface Sound {
  unlock(): void;
  playNote(frequency: number, options?: { sustain?: boolean }): NoteHandle;
  playError(): void;
  playLevelUp(): void;
}

const NO_HANDLE: NoteHandle = { release() {} };

export class AudioEngine implements Sound {
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

  playNote(frequency: number, { sustain = false } = {}): NoteHandle {
    const { ctx, master } = this;
    if (!ctx || !master) return NO_HANDLE;

    const now = ctx.currentTime;
    // Ordinary notes ring for 1.6s; sustained ones hold and only fade once released.
    const duration = sustain ? 8 : 1.6;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.9, now + 0.006);
    if (sustain) {
      envelope.gain.exponentialRampToValueAtTime(0.5, now + 0.25);
      envelope.gain.exponentialRampToValueAtTime(0.2, now + duration);
    } else {
      envelope.gain.exponentialRampToValueAtTime(0.3, now + 0.3);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    }

    // Separate stage for the release so it never has to read the envelope's current value.
    const releaseStage = ctx.createGain();

    // Brightness fades as the note rings out, like a struck string.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(frequency * 9, now);
    tone.frequency.exponentialRampToValueAtTime(frequency * 2, now + 0.9);

    tone.connect(envelope);
    envelope.connect(releaseStage);
    releaseStage.connect(master);

    const oscillators: OscillatorNode[] = [];
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
      oscillators.push(osc);
    }
    oscillators[0].onended = () => releaseStage.disconnect();

    if (!sustain) return NO_HANDLE;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const t = ctx.currentTime;
        releaseStage.gain.setValueAtTime(1, t);
        releaseStage.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        for (const osc of oscillators) osc.stop(t + 0.35);
      },
    };
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

  /** Quick rising two-note chime when the speed steps up. */
  playLevelUp(): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    [880, 1318.5].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      const start = now + i * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.4);
      osc.onended = () => gain.disconnect();
    });
  }
}
