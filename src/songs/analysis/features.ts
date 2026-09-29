import { Fft, melBank, melFrequencies, movingAverage } from './dsp';

/** The analysis works on audio at this rate, and looks at it in frames this many samples apart. */
export const SAMPLE_RATE = 22050;
export const HOP = 128; // 5.8 ms
const FFT_SIZE = 512;
export const FPS = SAMPLE_RATE / HOP;

/**
 * The onset envelope peaks a little before the sound really starts (the analysis window sees the
 * attack coming). This is how much later than an envelope peak the true onset is, in seconds,
 * measured on songs with known beats; the analyser's tests fail if it is off.
 */
export const ENV_LAG = 0.0033;

const MEL_BANDS = 26;
const MEL_LOW_HZ = 40;
const MEL_HIGH_HZ = 9000;
const TOP_DB = 80;
const AMIN = 1e-10;

export interface Features {
  /** Onset strength per frame, with the local average removed. */
  env: Float64Array;
  /** The same, per frequency band: under 250 Hz, up to 2.5 kHz, and above. */
  low: Float64Array;
  mid: Float64Array;
  high: Float64Array;
  /** Loudness per frame. */
  rms: Float64Array;
  /** Length of the audio, in seconds. */
  duration: number;
}

const detrend = (values: Float64Array) => {
  const average = movingAverage(values, Math.trunc(0.3 * FPS));
  const out = new Float64Array(values.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, values[i] - average[i]);
  return out;
};

/**
 * Listens to the audio (mono, at SAMPLE_RATE) for hits: how suddenly each frame gets louder in each
 * band of the mel scale, which is close to how loudness is heard. `onProgress` is given 0–1.
 */
export function computeFeatures(samples: Float32Array, onProgress?: (fraction: number) => void): Features {
  const frames = 1 + Math.floor(samples.length / HOP);
  const bank = melBank(SAMPLE_RATE, FFT_SIZE, MEL_BANDS, MEL_LOW_HZ, MEL_HIGH_HZ);
  const bins = FFT_SIZE / 2 + 1;
  const fft = new Fft(FFT_SIZE);
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  const mel = new Float64Array(frames * MEL_BANDS);
  const total = new Float64Array(frames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const powerA = new Float64Array(bins);
  const powerB = new Float64Array(bins);

  const fill = (target: Float64Array, frame: number) => {
    const start = frame * HOP - FFT_SIZE / 2; // (centred: the frame is around its own time)
    for (let i = 0; i < FFT_SIZE; i++) {
      const at = start + i;
      target[i] = at >= 0 && at < samples.length ? samples[at] * window[i] : 0;
    }
  };

  const applyBank = (power: Float64Array, frame: number) => {
    let sum = 0;
    for (let k = 0; k < bins; k++) sum += power[k];
    total[frame] = sum;
    for (let m = 0; m < MEL_BANDS; m++) {
      const weights = bank.weights[m];
      const first = bank.first[m];
      let band = 0;
      for (let k = 0; k < weights.length; k++) band += weights[k] * power[first + k];
      mel[frame * MEL_BANDS + m] = band;
    }
  };

  // Two real frames go through one complex FFT, one in the real part and one in the imaginary.
  for (let frame = 0; frame < frames; frame += 2) {
    const second = frame + 1 < frames;
    fill(re, frame);
    if (second) fill(im, frame + 1);
    else im.fill(0);
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) {
      const mirror = (FFT_SIZE - k) & (FFT_SIZE - 1);
      const ar = (re[k] + re[mirror]) / 2;
      const ai = (im[k] - im[mirror]) / 2;
      const br = (im[k] + im[mirror]) / 2;
      const bi = -(re[k] - re[mirror]) / 2;
      powerA[k] = ar * ar + ai * ai;
      powerB[k] = br * br + bi * bi;
    }
    applyBank(powerA, frame);
    if (second) applyBank(powerB, frame + 1);
    if (onProgress && (frame & 0x7ff) === 0) onProgress(frame / frames);
  }

  // Loudness in decibels below the loudest moment, never lower than TOP_DB down.
  let loudest = 0;
  for (let i = 0; i < mel.length; i++) if (mel[i] > loudest) loudest = mel[i];
  const reference = 10 * Math.log10(Math.max(AMIN, loudest));
  let top = -Infinity;
  for (let i = 0; i < mel.length; i++) {
    mel[i] = 10 * Math.log10(Math.max(AMIN, mel[i])) - reference;
    if (mel[i] > top) top = mel[i];
  }
  const floor = top - TOP_DB;
  for (let i = 0; i < mel.length; i++) if (mel[i] < floor) mel[i] = floor;

  // How much louder each band got since the frame before (getting quieter counts as nothing).
  const centres = melFrequencies(MEL_BANDS, MEL_LOW_HZ, MEL_HIGH_HZ);
  const lowBands: number[] = [];
  const midBands: number[] = [];
  const highBands: number[] = [];
  centres.forEach((hz, m) => (hz < 250 ? lowBands : hz <= 2500 ? midBands : highBands).push(m));

  const all = new Float64Array(frames);
  const low = new Float64Array(frames);
  const mid = new Float64Array(frames);
  const high = new Float64Array(frames);
  for (let frame = 1; frame < frames; frame++) {
    const here = frame * MEL_BANDS;
    const before = here - MEL_BANDS;
    const rise = (m: number) => Math.max(0, mel[here + m] - mel[before + m]);
    let sum = 0;
    for (let m = 0; m < MEL_BANDS; m++) sum += rise(m);
    all[frame] = sum / MEL_BANDS;
    const mean = (bands: number[]) => (bands.length ? bands.reduce((s, m) => s + rise(m), 0) / bands.length : 0);
    low[frame] = mean(lowBands);
    mid[frame] = mean(midBands);
    high[frame] = mean(highBands);
  }

  const loudness = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) loudness[frame] = Math.sqrt(total[frame]);

  onProgress?.(1);
  return {
    env: detrend(all),
    low: detrend(low),
    mid: detrend(mid),
    high: detrend(high),
    rms: movingAverage(loudness, Math.trunc(0.05 * FPS)),
    duration: samples.length / SAMPLE_RATE,
  };
}
