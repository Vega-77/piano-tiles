/**
 * Signal-processing building blocks for the beat analyser. Plain typed arrays in and out, with no
 * browser APIs, so they run the same in a worker, on the page and in a test.
 */

// ---- FFT --------------------------------------------------------------------------------------

/** A forward complex FFT of a fixed power-of-two size, done in place. */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('An FFT needs a power-of-two size');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reversed[i] = r;
    }
  }

  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let half = 1; half < n; half <<= 1) {
      const step = n / (half << 1);
      for (let start = 0; start < n; start += half << 1) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step];
          const s = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

// ---- mel filter bank --------------------------------------------------------------------------

// The Slaney mel scale: linear below 1 kHz, logarithmic above.
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

const hzToMel = (hz: number) => (hz < MIN_LOG_HZ ? hz / F_SP : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP);
const melToHz = (mel: number) => (mel < MIN_LOG_MEL ? mel * F_SP : MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)));

/** `count` frequencies (Hz) evenly spaced on the mel scale from `fmin` to `fmax`. */
export function melFrequencies(count: number, fmin: number, fmax: number): Float64Array {
  const low = hzToMel(fmin);
  const high = hzToMel(fmax);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = melToHz(count === 1 ? low : low + ((high - low) * i) / (count - 1));
  return out;
}

export interface MelBank {
  /** For each band: the first FFT bin it touches, and its weights from there. */
  first: Int32Array;
  weights: Float64Array[];
}

/** Triangular mel bands with area normalisation (what librosa's default `mel` makes). */
export function melBank(sampleRate: number, fftSize: number, bands: number, fmin: number, fmax: number): MelBank {
  const edges = melFrequencies(bands + 2, fmin, fmax);
  const bins = fftSize / 2 + 1;
  const first = new Int32Array(bands);
  const weights: Float64Array[] = [];
  for (let m = 0; m < bands; m++) {
    const rise = edges[m + 1] - edges[m];
    const fall = edges[m + 2] - edges[m + 1];
    const scale = 2 / (edges[m + 2] - edges[m]);
    const row = new Float64Array(bins);
    let lowest = -1;
    let highest = -1;
    for (let k = 0; k < bins; k++) {
      const hz = (k * sampleRate) / fftSize;
      const w = Math.max(0, Math.min((hz - edges[m]) / rise, (edges[m + 2] - hz) / fall)) * scale;
      row[k] = w;
      if (w > 0) {
        if (lowest < 0) lowest = k;
        highest = k;
      }
    }
    if (lowest < 0) {
      first[m] = 0;
      weights.push(new Float64Array(0));
    } else {
      first[m] = lowest;
      weights.push(row.slice(lowest, highest + 1));
    }
  }
  return { first, weights };
}

// ---- smoothing and statistics -----------------------------------------------------------------

/**
 * A running mean over `size` values centred on each one (the window starts `size / 2` before it),
 * with the first and last value repeated past the ends.
 */
export function movingAverage(values: Float64Array, size: number): Float64Array {
  const n = values.length;
  const width = Math.max(1, Math.trunc(size));
  const before = Math.floor(width / 2);
  const out = new Float64Array(n);
  if (n === 0) return out;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const from = i - before;
    const to = from + width; // (exclusive)
    let sum = 0;
    if (from < 0) sum += values[0] * Math.min(-from, width);
    if (to > n) sum += values[n - 1] * Math.min(to - n, width);
    const lo = Math.max(0, from);
    const hi = Math.min(n, to);
    if (hi > lo) sum += prefix[hi] - prefix[lo];
    out[i] = sum / width;
  }
  return out;
}

/** The `q`th percentile (0–100) of some numbers, interpolating between neighbours. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (n === 0) return 0;
  const position = (Math.min(100, Math.max(0, q)) / 100) * (n - 1);
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

/** A number in [low, high]. */
export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** `value` modulo `size`, never negative. */
export const modulo = (value: number, size: number) => ((value % size) + size) % size;

// ---- resampling -------------------------------------------------------------------------------

/** Windowed-sinc taps on each side of the centre, counted in periods of the cut-off. */
const ZERO_CROSSINGS = 12;
/** How finely the kernel is tabulated: steps per input sample. */
const KERNEL_STEPS = 2048;
/** Stay a little under the new Nyquist rate so the filter has room to roll off. */
const CUTOFF_MARGIN = 0.94;

export interface ResampleOptions {
  /** Output samples handled between calls to `pause`. */
  chunk?: number;
  /** Called between chunks with how far along it is (0–1); await something in it to give the page a turn. */
  pause?: (fraction: number) => void | Promise<void>;
}

/**
 * Mixes channels down to one and converts them from `from` to `to` samples a second with a
 * windowed-sinc low-pass, so nothing above the new rate folds back into the music. Every output
 * sample is centred exactly on its moment in the input: the timing of the music is untouched.
 */
export async function resampleMono(
  channels: readonly Float32Array[],
  from: number,
  to: number,
  options: ResampleOptions = {},
): Promise<Float32Array> {
  const length = channels.length > 0 ? channels[0].length : 0;
  const count = Math.max(0, Math.round((length * to) / from));
  const out = new Float32Array(count);
  if (count === 0) return out;

  const ratio = from / to; // input samples per output sample
  const cutoff = 0.5 * Math.min(1, to / from) * CUTOFF_MARGIN; // as a share of the input rate
  const reach = ZERO_CROSSINGS / (2 * cutoff); // input samples either side
  const tableSize = Math.ceil(reach * KERNEL_STEPS) + 1;
  const table = new Float64Array(tableSize);
  for (let i = 0; i < tableSize; i++) {
    const x = i / KERNEL_STEPS;
    const t = x / reach;
    const arg = 2 * Math.PI * cutoff * x;
    const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
    const window = 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
    table[i] = sinc * window;
  }

  const chunk = Math.max(1024, options.chunk ?? 1 << 16);
  const mix = 1 / channels.length;
  for (let first = 0; first < count; first += chunk) {
    const last = Math.min(count, first + chunk);
    const from0 = Math.max(0, Math.floor(first * ratio - reach) - 1);
    const to0 = Math.min(length, Math.ceil(last * ratio + reach) + 2);
    const block = new Float32Array(to0 - from0);
    for (const channel of channels) for (let i = 0; i < block.length; i++) block[i] += channel[from0 + i] * mix;

    for (let o = first; o < last; o++) {
      const centre = o * ratio;
      const lo = Math.max(0, Math.ceil(centre - reach));
      const hi = Math.min(length - 1, Math.floor(centre + reach));
      let sum = 0;
      let weight = 0;
      for (let j = lo; j <= hi; j++) {
        const w = table[Math.round(Math.abs(j - centre) * KERNEL_STEPS)];
        sum += w * block[j - from0];
        weight += w;
      }
      out[o] = weight > 0 ? sum / weight : 0;
    }
    await options.pause?.(last / count);
  }
  return out;
}
