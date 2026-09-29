// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from './analysis/features';
import { CANT_READ_AUDIO, audioToKeep, decodeToSamples, encodeWav, type Decoder, type Step } from './decode';
import { Cancelled, ImportError } from './errors';
import { fakeDecoded, fakeFile } from './testing';

describe('decoding a song file', () => {
  it('gives back mono samples at the analyser’s rate, and how far along it is', async () => {
    const decoder: Decoder = async () => fakeDecoded(3, { sampleRate: 44100, channels: 2 });
    const steps: Step[] = [];
    const { samples, decoded } = await decodeToSamples(fakeFile(100, 'a.mp3'), { decoder, onStep: (step) => steps.push(step) });
    expect(samples.length).toBe(3 * SAMPLE_RATE);
    expect(decoded.numberOfChannels).toBe(2);
    expect(steps[0]).toEqual({ message: 'Reading the file', fraction: 0 });
    expect(steps.every((step, i) => i === 0 || step.fraction >= steps[i - 1].fraction)).toBe(true);
    expect(steps.at(-1)!.fraction).toBeGreaterThan(0.9);
  });

  it('says so when the browser cannot decode the file', async () => {
    const decoder: Decoder = async () => {
      throw new DOMException('Unable to decode audio data', 'EncodingError');
    };
    const error = await decodeToSamples(fakeFile(100, 'a.xyz'), { decoder }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as Error).message).toBe(CANT_READ_AUDIO);
  });

  it('says so when there is no sound in the file', async () => {
    const decoder: Decoder = async () => fakeDecoded(0);
    await expect(decodeToSamples(fakeFile(100, 'a.mp3'), { decoder })).rejects.toThrow(/no sound/);
  });

  it('stops when told to, at any point', async () => {
    const controller = new AbortController();
    const decoder: Decoder = async () => {
      controller.abort();
      return fakeDecoded(3);
    };
    await expect(decodeToSamples(fakeFile(100, 'a.mp3'), { decoder, signal: controller.signal })).rejects.toBeInstanceOf(Cancelled);

    const later = new AbortController();
    await expect(
      decodeToSamples(fakeFile(100, 'a.mp3'), {
        decoder: async () => fakeDecoded(20),
        signal: later.signal,
        onStep: (step) => {
          if (step.fraction > 0.5) later.abort();
        },
      }),
    ).rejects.toBeInstanceOf(Cancelled);
  });
});

describe('the WAV that is kept for a video or a large file', () => {
  it('has a proper header and the samples in it', async () => {
    const decoded = fakeDecoded(0.5, { sampleRate: 8000, channels: 2 });
    const wav = encodeWav(decoded);
    expect(wav.type).toBe('audio/wav');
    const bytes = await wav.arrayBuffer();
    expect(bytes.byteLength).toBe(44 + 4000 * 2 * 2);

    const view = new DataView(bytes);
    const text = (at: number) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4000 * 2 * 2);

    // Left then right, one frame at a time, to within one step of 16 bits.
    for (const frame of [0, 100, 3999]) {
      for (const channel of [0, 1]) {
        const written = view.getInt16(44 + (frame * 2 + channel) * 2, true) / 32767;
        expect(written).toBeCloseTo(decoded.getChannelData(channel)[frame], 3);
      }
    }
  });

  it('keeps a mono song mono, and clips what is too loud', async () => {
    const loud = { sampleRate: 8000, length: 3, numberOfChannels: 1, getChannelData: () => Float32Array.from([2, -2, 0]) };
    const view = new DataView(await encodeWav(loud).arrayBuffer());
    expect(view.getUint16(22, true)).toBe(1);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([32767, -32768, 0]);
  });
});

describe('choosing what to keep of a song file', () => {
  const decoded = fakeDecoded(1, { sampleRate: 8000 });

  it('keeps a small mp3, m4a, aac or wav as it came', async () => {
    for (const [name, type, ext] of [
      ['Song.MP3', 'audio/mpeg', 'mp3'],
      ['a.m4a', 'audio/mp4', 'm4a'],
      ['a.aac', 'audio/aac', 'aac'],
      ['a.wav', 'audio/wav', 'wav'],
    ] as const) {
      const file = fakeFile(1000, name);
      const kept = audioToKeep(file, decoded);
      expect(kept).toMatchObject({ ext, type });
      expect(kept.blob.type).toBe(type);
      expect(kept.blob.size).toBe(1000);
    }
  });

  it('makes a WAV of a video, or of a format not every browser plays', async () => {
    for (const name of ['clip.mp4', 'clip.mov', 'a.ogg', 'a.flac', 'noextension']) {
      const kept = audioToKeep(fakeFile(1000, name), decoded);
      expect(kept).toMatchObject({ ext: 'wav', type: 'audio/wav' });
      expect(kept.blob.size).toBe(44 + 8000 * 2 * 2);
    }
  });

  it('makes a WAV of a file that is too big to keep', () => {
    const big = { size: 41 * 1024 * 1024, name: 'huge.mp3', slice: () => new Blob() } as unknown as File;
    expect(audioToKeep(big, decoded).ext).toBe('wav');
  });
});
