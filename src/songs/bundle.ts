import { validateChart, type ChartFile } from './chart';
import { ImportError } from './errors';

/**
 * A song file: one file holding a song's chart and audio, to move a song to another device (or keep
 * a copy). Laid out as
 *
 *   PIANOTILES-SONG\n  (16 bytes)  |  header length (uint32, little-endian)  |  header (JSON)  |  audio
 *
 * where the header is `{ version, chart, audio: { type, bytes } }`. The audio is not re-encoded or
 * copied into a string, so a long song is as big as its audio and no more.
 */
export const SONG_FILE_EXTENSION = '.pianotiles';

const MAGIC = 'PIANOTILES-SONG\n';
const PREFIX = MAGIC.length + 4;
/** A chart is a few kilobytes; a header bigger than this is not one of ours. */
const MAX_HEADER = 4 * 1024 * 1024;

const magic = new TextEncoder().encode(MAGIC);

export const songFileName = (chart: Pick<ChartFile, 'id'>) => `${chart.id}${SONG_FILE_EXTENSION}`;

export function packSong(chart: ChartFile, audio: Blob): Blob {
  const header = new TextEncoder().encode(
    JSON.stringify({ version: 1, chart, audio: { type: audio.type || 'audio/mpeg', bytes: audio.size } }),
  );
  const length = new DataView(new ArrayBuffer(4));
  length.setUint32(0, header.length, true);
  return new Blob([magic, length.buffer, header, audio], { type: 'application/octet-stream' });
}

/** Whether a file is a song file (by what is inside it, not what it is called). */
export async function isSongFile(file: Blob): Promise<boolean> {
  if (file.size < PREFIX) return false;
  try {
    const start = new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer());
    return start.every((byte, i) => byte === magic[i]);
  } catch {
    return false;
  }
}

const NOT_A_SONG_FILE = "That isn't a song file this app can read.";

/** Opens a song file. Throws an ImportError, worded for the player, if it is damaged or from something else. */
export async function unpackSong(file: Blob): Promise<{ chart: ChartFile; audio: Blob }> {
  if (!(await isSongFile(file))) throw new ImportError(NOT_A_SONG_FILE);

  let length: number;
  try {
    length = new DataView(await file.slice(MAGIC.length, PREFIX).arrayBuffer()).getUint32(0, true);
  } catch {
    throw new ImportError("Couldn't read that song file.");
  }
  if (length === 0 || length > MAX_HEADER || PREFIX + length > file.size) throw new ImportError('That song file is damaged.');

  let header: unknown;
  try {
    header = JSON.parse(await file.slice(PREFIX, PREFIX + length).text());
  } catch {
    throw new ImportError('That song file is damaged.');
  }
  const { version, chart: rawChart, audio } = (typeof header === 'object' && header !== null ? header : {}) as Record<string, unknown>;
  if (version !== 1) throw new ImportError('That song file is from a newer version of the app. Reload the page and try again.');

  let chart: ChartFile;
  try {
    chart = validateChart(rawChart);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : 'That song file is damaged.');
  }

  const info = (typeof audio === 'object' && audio !== null ? audio : {}) as { type?: unknown; bytes?: unknown };
  const bytes = info.bytes;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0 || PREFIX + length + bytes !== file.size) {
    throw new ImportError('That song file is damaged: its audio is cut short.');
  }
  const type = typeof info.type === 'string' && /^audio\/[\w.+-]{1,60}$/.test(info.type) ? info.type : 'audio/mpeg';
  return { chart, audio: file.slice(PREFIX + length, file.size, type) };
}
