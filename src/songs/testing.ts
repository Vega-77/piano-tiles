/** Little fakes for the tests of the song code (nothing here is used by the app). */
import type { ChartFile } from './chart';
import type { DecodedAudio } from './decode';

export function fakeChart(id = 'demo', overrides: Partial<ChartFile> = {}): ChartFile {
  return {
    version: 1,
    id,
    title: id.toUpperCase(),
    artist: 'Band',
    audio: 'audio-00000000.mp3',
    bpm: 120,
    rowsPerBeat: 2,
    offset: 0,
    duration: 30,
    difficulty: 2,
    hue: 10,
    hue2: 20,
    chart: 'x . x .',
    ...overrides,
  };
}

/** Sound that is a slow sine wave (a different pitch in each channel), so a test can tell channels and positions apart. */
export function fakeDecoded(seconds: number, { sampleRate = 44100, channels = 2 } = {}): DecodedAudio {
  const length = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length }, (_, i) => 0.5 * Math.sin((2 * Math.PI * (220 * (c + 1)) * i) / sampleRate)),
  );
  return { sampleRate, length, numberOfChannels: channels, getChannelData: (channel) => data[channel] };
}

export const fakeFile = (bytes: number | Uint8Array<ArrayBuffer>, name: string, type = ''): File =>
  new File([typeof bytes === 'number' ? new Uint8Array(bytes).fill(7) : bytes], name, { type });
