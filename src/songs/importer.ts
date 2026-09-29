import { fingerprintOf, type AnalyzeOptions } from './analysis/analyze';
import { analyzeSamples, type Analyser } from './analysis/client';
import type { Density } from './analysis/tiles';
import { isSongFile, packSong, songFileName, unpackSong } from './bundle';
import { MAX_NUDGE, validateChart, type ChartFile } from './chart';
import { MAX_UPLOAD_MB, audioToKeep, browserDecoder, decodeToSamples, type Decoder, type StoredAudio } from './decode';
import { Cancelled, ImportError } from './errors';
import { SONGS } from './songs';
import { MISSING_AUDIO, getSongStore, keepSongs, type SongStore } from './store';

/**
 * Adding, changing and removing the songs a player brings. The whole job happens in this browser:
 * the file is decoded here, the beat is found by a worker here (analysis/), and the chart and audio
 * are saved here (store.ts). Nothing is uploaded, and nothing needs installing.
 */

export { DENSITIES, type Density } from './analysis/tiles';
export { Cancelled, ImportError } from './errors';
export { MAX_UPLOAD_MB } from './decode';

/** A step of a job, and how far through the whole job it is (0–1). */
export interface Stage {
  message: string;
  fraction: number;
}

export interface Job {
  signal?: AbortSignal;
  onStage?: (stage: Stage) => void;
}

export interface ImportOptions {
  title?: string;
  artist?: string;
  /** The tempo, when it is known: the analyser only looks for it if this is left out. */
  bpm?: number;
  density?: Density;
}

export interface RechartOptions {
  title?: string;
  bpm?: number;
  density?: Density;
  /** Forget a tempo that was given by hand and detect it again. */
  auto?: boolean;
}

export interface TuneOptions {
  title?: string;
  artist?: string;
  /** How far, in milliseconds, to move the audio against the tiles: positive if the tiles are early. */
  nudgeMs?: number;
}

/** What a job needs from the outside world; tests pass their own. */
export interface Tools {
  store(): Promise<SongStore>;
  decoder: Decoder;
  analyse: Analyser;
  /** Ids the built-in songs already have. */
  reserved: readonly string[];
}

export const defaultTools: Tools = {
  store: getSongStore,
  decoder: browserDecoder,
  analyse: analyzeSamples,
  reserved: SONGS.map((song) => song.id),
};

const MIN_BPM = 40;
const MAX_BPM = 300;
const MAX_TEXT = 120;

// ---- small helpers ----------------------------------------------------------------------------

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'song';
}

/** `wanted`, or `wanted-2`, `wanted-3`... whichever is free. */
export function uniqueId(wanted: string, taken: ReadonlySet<string>): string {
  const base = wanted.slice(0, 60);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A song's name from its file's: no ending, underscores as spaces. */
export function titleFromFileName(name: string): string {
  const title = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || 'Untitled').slice(0, MAX_TEXT);
}

const stager = (job: Job) => (message: string, fraction: number) =>
  job.onStage?.({ message, fraction: Math.min(1, Math.max(0, fraction)) });

function notCancelled(job: Job): void {
  if (job.signal?.aborted) throw new Cancelled();
}

function checkFile(file: Blob): void {
  if (file.size === 0) throw new ImportError('That file is empty.');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new ImportError(`That file is over ${MAX_UPLOAD_MB} MB.`);
}

function checkBpm(bpm: number | undefined): void {
  if (bpm !== undefined && (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM)) {
    throw new ImportError(`The tempo has to be between ${MIN_BPM} and ${MAX_BPM} beats per minute.`);
  }
}

/** Ids in use: the built-in songs' and the saved ones'. */
async function takenIds(store: SongStore, tools: Tools): Promise<Set<string>> {
  const taken = new Set(tools.reserved);
  for (const chart of await store.charts()) {
    const id = (chart as { id?: unknown } | null)?.id;
    if (typeof id === 'string') taken.add(id);
  }
  return taken;
}

async function savedChart(store: SongStore, id: string): Promise<ChartFile> {
  const raw = await store.chart(id);
  if (raw === undefined) throw new ImportError('That song is no longer on this device.');
  try {
    return validateChart(raw);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : 'That song could not be read.');
  }
}

const levelOf = (chart: ChartFile): Density => (chart.analysis?.level === 'easy' || chart.analysis?.level === 'hard' ? chart.analysis.level : 'normal');

function checked(chart: ChartFile): ChartFile {
  try {
    return validateChart(chart);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : 'The song could not be charted.');
  }
}

/** What is left of a song file once it has been listened to: kept small so the decoded sound can be let go. */
async function prepare(file: File, job: Job, tools: Tools, share: number): Promise<{ samples: Float32Array; fingerprint: number; audio: StoredAudio }> {
  const stage = stager(job);
  const { samples, decoded } = await decodeToSamples(file, {
    decoder: tools.decoder,
    signal: job.signal,
    onStep: (step) => stage(step.message, share * step.fraction),
  });
  return { samples, fingerprint: fingerprintOf(samples), audio: audioToKeep(file, decoded) };
}

// ---- what the app can ask for -----------------------------------------------------------------

/**
 * Adds a song from a recording (any audio or video file the browser can decode) or from a song
 * file exported by this app. Resolves with the song's chart.
 */
export async function addSong(file: File, options: ImportOptions = {}, job: Job = {}, tools: Tools = defaultTools): Promise<ChartFile> {
  checkFile(file);
  checkBpm(options.bpm);
  if (await isSongFile(file)) return addSongFile(file, job, tools);

  const stage = stager(job);
  const store = await tools.store();
  const { samples, fingerprint, audio } = await prepare(file, job, tools, 0.3);

  const analyzeOptions: AnalyzeOptions = { density: options.density ?? 'normal', bpm: options.bpm };
  const measured = await tools.analyse(samples, analyzeOptions, (progress) => stage(progress.message, 0.3 + 0.62 * (progress.fraction ?? 0)), job.signal);
  notCancelled(job);

  stage('Saving the song', 0.94);
  const title = (options.title?.trim() || titleFromFileName(file.name)).slice(0, MAX_TEXT);
  const id = uniqueId(slugify(title), await takenIds(store, tools));
  const hue = (fingerprint >>> 8) % 360;
  const chart = checked({
    version: 1,
    id,
    title,
    artist: options.artist?.trim().slice(0, MAX_TEXT) || 'Imported',
    audio: `audio-${fingerprint.toString(16).padStart(8, '0')}.${audio.ext}`,
    hue,
    hue2: (hue + 55) % 360,
    ...measured,
  });
  await store.save(chart, audio.blob);
  void keepSongs();
  stage('Done', 1);
  return chart;
}

/** Puts the tiles of a saved song on the beat again, with another tempo or busyness. */
export async function rechartSong(id: string, options: RechartOptions = {}, job: Job = {}, tools: Tools = defaultTools): Promise<ChartFile> {
  checkBpm(options.bpm);
  const stage = stager(job);
  const store = await tools.store();
  const old = await savedChart(store, id);
  const audio = await store.audio(id);
  if (!audio) throw new ImportError(MISSING_AUDIO);

  const { samples } = await decodeToSamples(audio, {
    decoder: tools.decoder,
    signal: job.signal,
    onStep: (step) => stage(step.message, 0.3 * step.fraction),
  });
  const keepsHandTempo = old.analysis?.manualBpm === true && !options.auto;
  const analyzeOptions: AnalyzeOptions = { density: options.density ?? levelOf(old), bpm: options.bpm ?? (keepsHandTempo ? old.bpm : undefined) };
  const measured = await tools.analyse(samples, analyzeOptions, (progress) => stage(progress.message, 0.3 + 0.65 * (progress.fraction ?? 0)), job.signal);
  notCancelled(job);

  stage('Saving the song', 0.97);
  const title = options.title?.trim().slice(0, MAX_TEXT) || old.title;
  // (Its name, colours, audio and hand-set nudge stay as they were.)
  const chart = checked({ ...old, title, ...measured });
  await store.save(chart);
  stage('Done', 1);
  return chart;
}

/** Changes a saved song's name, or moves its audio against its tiles (no analysis). */
export async function tuneSong(id: string, options: TuneOptions, _job: Job = {}, tools: Tools = defaultTools): Promise<ChartFile> {
  const store = await tools.store();
  const chart: ChartFile = { ...(await savedChart(store, id)) };

  if (options.title !== undefined) {
    const title = options.title.trim().slice(0, MAX_TEXT);
    if (!title) throw new ImportError('A song needs a name.');
    chart.title = title;
  }
  if (options.artist !== undefined) chart.artist = options.artist.trim().slice(0, MAX_TEXT) || 'Imported';
  if (options.nudgeMs !== undefined) {
    const limit = MAX_NUDGE * 1000;
    if (!Number.isFinite(options.nudgeMs) || Math.abs(options.nudgeMs) > limit) {
      throw new ImportError(`The sync nudge can be at most ${limit} ms either way.`);
    }
    if (options.nudgeMs === 0) delete chart.nudge;
    else chart.nudge = Math.round(options.nudgeMs * 10) / 10000;
  }
  await store.save(checked(chart));
  return chart;
}

/** Deletes a saved song and its audio. */
export async function removeSong(id: string, _job: Job = {}, tools: Tools = defaultTools): Promise<void> {
  await (await tools.store()).remove(id);
}

/** A song as a file to keep or move to another device: its chart and audio together. */
export async function exportSong(id: string, tools: Tools = defaultTools): Promise<{ blob: Blob; filename: string }> {
  const store = await tools.store();
  const chart = await savedChart(store, id);
  const audio = await store.audio(id);
  if (!audio) throw new ImportError(MISSING_AUDIO);
  return { blob: packSong(chart, audio), filename: songFileName(chart) };
}

/** Adds a song from a song file. The same song again replaces what is saved; another song with the same id gets a new one. */
async function addSongFile(file: File, job: Job, tools: Tools): Promise<ChartFile> {
  const stage = stager(job);
  stage('Opening the song file', 0.2);
  const { chart, audio } = await unpackSong(file);
  notCancelled(job);

  const store = await tools.store();
  const saved = (await store.charts()).find((raw) => (raw as { id?: unknown } | null)?.id === chart.id) as { audio?: unknown } | undefined;
  let id = chart.id;
  if (saved?.audio !== chart.audio) id = uniqueId(id, await takenIds(store, tools));

  stage('Saving the song', 0.7);
  const added = { ...chart, id };
  await store.save(added, audio);
  void keepSongs();
  stage('Done', 1);
  return added;
}
