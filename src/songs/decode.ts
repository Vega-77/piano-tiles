import { resampleMono } from './analysis/dsp';
import { SAMPLE_RATE } from './analysis/features';
import { Cancelled, ImportError } from './errors';

/** The largest file the app takes. Decoding holds the whole song in memory, so a phone will manage less. */
export const MAX_UPLOAD_MB = 300;

/** Songs in these formats are kept as they came (every browser can play them); anything else is stored as a WAV. */
const KEPT_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
};
/** A bigger file than this is stored as a WAV instead, which is usually smaller than the video or lossless file it came from. */
const KEEP_LIMIT = 40 * 1024 * 1024;

/** The parts of an `AudioBuffer` that are used here, so a test can hand in its own. */
export interface DecodedAudio {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Turns the bytes of a song file into sound. The browser's own decoder does it: mp3, m4a, mp4, wav, ogg... */
export type Decoder = (bytes: ArrayBuffer) => Promise<DecodedAudio>;

const DECODE_RATE = 44100;

export const browserDecoder: Decoder = (bytes) => {
  if (typeof OfflineAudioContext === 'undefined') throw new Error('This browser cannot decode audio.');
  return new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(bytes);
};

export const CANT_READ_AUDIO =
  "This device couldn't read the audio in that file. An mp3, m4a or wav usually works; a video needs an audio track.";

export interface StoredAudio {
  blob: Blob;
  /** File name ending, without the dot. */
  ext: string;
  type: string;
}

/** A step of preparing a song, and how far through the whole of the preparing it is (0–1). */
export interface Step {
  message: string;
  fraction: number;
}

export interface DecodeOptions {
  decoder?: Decoder;
  signal?: AbortSignal;
  onStep?: (step: Step) => void;
}

/** Gives the page a turn (to draw a progress bar, to answer a tap) between chunks of work. */
const letPageBreathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Reads a song file and gives back what the analyser hears (mono at SAMPLE_RATE) along with the
 * decoded audio itself. It goes a chunk at a time so a long song doesn't freeze the page.
 */
export async function decodeToSamples(
  source: Blob,
  { decoder = browserDecoder, signal, onStep }: DecodeOptions = {},
): Promise<{ samples: Float32Array; decoded: DecodedAudio }> {
  const check = () => {
    if (signal?.aborted) throw new Cancelled();
  };

  onStep?.({ message: 'Reading the file', fraction: 0 });
  let bytes: ArrayBuffer;
  try {
    bytes = await source.arrayBuffer();
  } catch {
    throw new ImportError("Couldn't read that file. If it is on a network drive or was changed just now, try again.");
  }
  check();

  onStep?.({ message: 'Decoding the audio', fraction: 0.1 });
  let decoded: DecodedAudio;
  try {
    decoded = await decoder(bytes);
  } catch {
    check();
    throw new ImportError(CANT_READ_AUDIO);
  }
  check();
  if (decoded.length === 0 || decoded.numberOfChannels === 0) throw new ImportError('That file has no sound in it.');

  onStep?.({ message: 'Getting ready to listen', fraction: 0.3 });
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const samples = await resampleMono(channels, decoded.sampleRate, SAMPLE_RATE, {
    pause: async (fraction) => {
      onStep?.({ message: 'Getting ready to listen', fraction: 0.3 + 0.7 * fraction });
      await letPageBreathe();
      check();
    },
  });
  return { samples, decoded };
}

/** A 16-bit WAV of the sound (left and right if there are more than two channels). */
export function encodeWav(audio: DecodedAudio): Blob {
  const channels = Math.min(2, audio.numberOfChannels);
  const frames = audio.length;
  const bytes = frames * channels * 2;
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  header.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // plain PCM
  header.setUint16(22, channels, true);
  header.setUint32(24, audio.sampleRate, true);
  header.setUint32(28, audio.sampleRate * channels * 2, true);
  header.setUint16(32, channels * 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, bytes, true);

  const pcm = new Int16Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const value = Math.max(-1, Math.min(1, data[i]));
      pcm[i * channels + c] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
    }
  }
  // (Little-endian on every device that runs a browser.)
  return new Blob([header.buffer, pcm.buffer], { type: 'audio/wav' });
}

/** What to keep of a song file: the file itself if it is a small mp3, m4a or wav, else a WAV made from the decoded sound. */
export function audioToKeep(source: Blob & { name?: string }, decoded: DecodedAudio): StoredAudio {
  const ext = /\.([a-z0-9]+)$/i.exec(source.name ?? '')?.[1]?.toLowerCase() ?? '';
  const type = KEPT_TYPES[ext];
  if (type && source.size <= KEEP_LIMIT) return { blob: source.slice(0, source.size, type), ext, type };
  return { blob: encodeWav(decoded), ext: 'wav', type: 'audio/wav' };
}
