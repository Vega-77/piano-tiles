// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SONG_FILE_EXTENSION, isSongFile, packSong, songFileName, unpackSong } from './bundle';
import { ImportError } from './errors';
import { fakeChart } from './testing';

const audio = () => new Blob([new Uint8Array([1, 2, 3, 4, 5, 250, 251])], { type: 'audio/mp4' });

/** A song file with its header replaced, for the damaged ones. */
async function withHeader(header: unknown, audioBytes = 4): Promise<Blob> {
  const packed = await packSong(fakeChart(), audio()).arrayBuffer();
  const prefix = new Uint8Array(packed.slice(0, 16));
  const text = new TextEncoder().encode(JSON.stringify(header));
  const length = new DataView(new ArrayBuffer(4));
  length.setUint32(0, text.length, true);
  return new Blob([prefix, length.buffer, text, new Uint8Array(audioBytes)]);
}

describe('song files', () => {
  it('carry a song and its audio and give them back unchanged', async () => {
    const chart = fakeChart('my-song', { title: 'Mine — très bien 🎵', nudge: 0.03 });
    const file = packSong(chart, audio());
    const opened = await unpackSong(file);
    expect(opened.chart).toEqual(chart);
    expect(opened.audio.type).toBe('audio/mp4');
    expect(new Uint8Array(await opened.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 250, 251]));
  });

  it('are named after the song', () => {
    expect(songFileName({ id: 'my-song' })).toBe('my-song.pianotiles');
    expect(SONG_FILE_EXTENSION).toBe('.pianotiles');
  });

  it('are recognised by what is inside, whatever they are called', async () => {
    expect(await isSongFile(packSong(fakeChart(), audio()))).toBe(true);
    expect(await isSongFile(new Blob(['ID3 not one of ours, just a long enough file of text']))).toBe(false);
    expect(await isSongFile(new Blob([]))).toBe(false);
    expect(await isSongFile(new Blob(['PIANOTILES']))).toBe(false);
  });

  it('refuse a file that is something else', async () => {
    await expect(unpackSong(new Blob(['just some text, nothing to see here']))).rejects.toBeInstanceOf(ImportError);
  });

  it('refuse a header that is not JSON, or is cut off', async () => {
    const whole = await packSong(fakeChart(), audio()).arrayBuffer();
    await expect(unpackSong(new Blob([whole.slice(0, 40)]))).rejects.toThrow(/damaged/);
    const garbled = new Uint8Array(whole.slice(0));
    garbled.set(new TextEncoder().encode('{{{{'), 20);
    await expect(unpackSong(new Blob([garbled]))).rejects.toThrow(/damaged/);
  });

  it('refuse a header that claims to be enormous', async () => {
    const prefix = new TextEncoder().encode('PIANOTILES-SONG\n');
    const length = new DataView(new ArrayBuffer(4));
    length.setUint32(0, 0xffffffff, true);
    await expect(unpackSong(new Blob([prefix, length.buffer, new Uint8Array(20)]))).rejects.toThrow(/damaged/);
  });

  it('refuse a version from the future', async () => {
    const file = await withHeader({ version: 2, chart: fakeChart(), audio: { type: 'audio/mpeg', bytes: 4 } });
    await expect(unpackSong(file)).rejects.toThrow(/newer version/);
  });

  it('refuse a chart the game could not play, in the chart validator’s words', async () => {
    const file = await withHeader({ version: 1, chart: { ...fakeChart(), bpm: 9000 }, audio: { type: 'audio/mpeg', bytes: 4 } });
    await expect(unpackSong(file)).rejects.toThrow(/bpm/);
  });

  it('refuse audio that was cut short or has something added', async () => {
    const chart = fakeChart();
    await expect(unpackSong(await withHeader({ version: 1, chart, audio: { type: 'audio/mpeg', bytes: 10 } }))).rejects.toThrow(/cut short/);
    await expect(unpackSong(await withHeader({ version: 1, chart, audio: { type: 'audio/mpeg', bytes: 2 } }))).rejects.toThrow(/cut short/);
    await expect(unpackSong(await withHeader({ version: 1, chart, audio: { type: 'audio/mpeg' } }))).rejects.toThrow(/cut short/);
  });

  it('do not let the file choose a strange type for the audio', async () => {
    const chart = fakeChart();
    const opened = await unpackSong(await withHeader({ version: 1, chart, audio: { type: 'text/html', bytes: 4 } }));
    expect(opened.audio.type).toBe('audio/mpeg');
  });
});
