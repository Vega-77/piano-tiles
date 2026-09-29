/**
 * Little songs made in code, for testing the analyser where the true tempo and first beat are known
 * (and for anyone who wants something to drop into the app without a recording). Nothing here ships
 * in the game itself.
 */
import { SAMPLE_RATE } from './features';
import { resampleMono } from './dsp';

export const SYNTH_RATE = 44100;

/** A small, fast, seedable random number generator: 0 ≤ value < 1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  bpm: number;
  /** Seconds into the audio at which beat 1 falls. */
  offset: number;
  seconds: number;
  seed?: number;
  /** How far (seconds, standard deviation) each player is off the beat, like a human band. */
  jitter?: number;
  /** Speeds the song up: a beat that would fall at t falls at t − warp·t²/seconds. */
  warp?: number;
}

/**
 * Kick, snare, hats, a bass line and a lead, mono at SYNTH_RATE. Beats fall every 60/bpm seconds
 * from `offset`, with the lead and hats on the eighth notes between.
 */
export function synth({ bpm, offset, seconds, seed = 1, jitter = 0, warp = 0 }: SynthOptions): Float32Array {
  const random = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const out = new Float64Array(Math.floor(seconds * SYNTH_RATE));
  const beat = 60 / bpm;

  const add = (time: number, sound: Float64Array, gain: number) => {
    const at = time - (warp * time * time) / seconds + (jitter > 0 ? jitter * gauss() : 0);
    const start = Math.round(at * SYNTH_RATE);
    if (start < 0 || start >= out.length) return;
    const fade = Math.min(sound.length, Math.floor(0.03 * SYNTH_RATE)); // no click where a sound is cut off
    const end = Math.min(out.length, start + sound.length);
    for (let i = 0; i < end - start; i++) {
      const fromEnd = sound.length - 1 - i;
      const ramp = fromEnd < fade ? (fade > 1 ? fromEnd / (fade - 1) : 0) : 1;
      out[start + i] += gain * sound[i] * ramp;
    }
  };

  const envelope = (n: number, decay: number) => Float64Array.from({ length: n }, (_, i) => Math.exp(-i / SYNTH_RATE / decay));
  const kickLength = Math.floor(0.4 * SYNTH_RATE);
  const kickEnv = envelope(kickLength, 0.12);
  const kick = Float64Array.from({ length: kickLength }, (_, i) => {
    const t = i / SYNTH_RATE;
    return Math.sin(2 * Math.PI * (45 * t + (90 * (1 - Math.exp(-t * 30))) / 30)) * kickEnv[i];
  });
  const snareLength = Math.floor(0.25 * SYNTH_RATE);
  const snareEnv = envelope(snareLength, 0.06);
  const snare = Float64Array.from({ length: snareLength }, (_, i) => gauss() * 0.8 * snareEnv[i]);
  const hatLength = Math.floor(0.08 * SYNTH_RATE);
  const hatEnv = envelope(hatLength, 0.015);
  const noise = Float64Array.from({ length: hatLength + 1 }, gauss);
  const hat = Float64Array.from({ length: hatLength }, (_, i) => (noise[i + 1] - noise[i]) * hatEnv[i]);

  const pluckLength = Math.floor(0.5 * SYNTH_RATE);
  const plucks = new Map<string, Float64Array>();
  const pluck = (freq: number, decay: number) => {
    const key = `${freq}/${decay}`;
    let sound = plucks.get(key);
    if (!sound) {
      const env = envelope(pluckLength, decay);
      sound = Float64Array.from({ length: pluckLength }, (_, i) => {
        const t = i / SYNTH_RATE;
        return (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(4 * Math.PI * freq * t)) * env[i];
      });
      plucks.set(key, sound);
    }
    return sound;
  };

  const scale = [261.63, 293.66, 329.63, 392.0, 440.0];
  for (let step = 0; ; step++) {
    const at = offset + (step * beat) / 2; // eighth notes
    if (at >= seconds) break;
    const onBeat = step % 2 === 0;
    const barPosition = Math.floor(step / 2) % 4;
    if (onBeat && (barPosition === 0 || barPosition === 2)) add(at, kick, 0.9);
    if (onBeat && (barPosition === 1 || barPosition === 3)) add(at, snare, 0.6);
    add(at, hat, onBeat ? 0.25 : 0.14);
    if (onBeat) add(at, pluck(65.41 * (barPosition < 2 ? 1 : 1.5), 0.25), 0.35);
    if ([0, 3, 6].includes(step % 8)) add(at, pluck(scale[Math.floor(random() * scale.length)], 0.18), 0.25);
  }

  let loudest = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] += 0.01 * gauss();
    loudest = Math.max(loudest, Math.abs(out[i]));
  }
  const scaleDown = Math.max(1, loudest / 0.9);
  return Float32Array.from(out, (value) => value / scaleDown);
}

/** The same song as the analyser hears it: mono at SAMPLE_RATE. */
export function synthForAnalysis(options: SynthOptions): Promise<Float32Array> {
  return resampleMono([synth(options)], SYNTH_RATE, SAMPLE_RATE);
}
