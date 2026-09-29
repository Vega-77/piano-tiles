import { useCallback, useRef, useState } from 'react';
import { CloudError, describeCloudError } from '../cloud/errors';
import { firebaseBackend } from '../cloud/firebase';
import { publishSong, unpublishSong } from '../cloud/publish';
import type { CloudBackend } from '../cloud/types';
import type { ChartFile } from '../songs/chart';
import {
  addSong,
  Cancelled,
  exportSong,
  ImportError,
  rechartSong,
  removeSong,
  tuneSong,
  type Job,
  type RechartOptions,
  type TuneOptions,
} from '../songs/importer';
import { getSongStore } from '../songs/store';

/** What is being worked on, the latest thing the analyser said about it, and how far along it is (0 to 1). */
export interface Working {
  what: string;
  stage: string;
  fraction: number;
}

/** Hands a song file to the browser to save, the way a download link does. */
function saveToDevice(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Runs a job that goes through the cloud, so that whatever the cloud says no to reads as words (the jobs here only know their own errors). */
async function viaCloud<T>(job: () => Promise<T>): Promise<T> {
  try {
    return await job();
  } catch (failure) {
    if (failure instanceof Cancelled || failure instanceof ImportError || failure instanceof CloudError) throw failure;
    console.error('A job with the cloud failed', failure);
    throw new CloudError(describeCloudError(failure) ?? 'Something went wrong with the cloud.');
  }
}

/**
 * Adding, tuning, exporting and removing songs, one job at a time, all inside this browser.
 * `refresh` reads the library again once a job has changed it. Publishing and unpublishing (for an
 * admin) also go through the cloud `backend`.
 */
export function useImporter(refresh: () => Promise<void>, backend: CloudBackend = firebaseBackend) {
  const [working, setWorking] = useState<Working | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ChartFile | null>(null);
  const running = useRef<AbortController | null>(null);

  const run = useCallback(
    async <T>(what: string, task: (job: Job) => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      const controller = new AbortController();
      running.current = controller;
      setError(null);
      setWorking({ what, stage: 'Starting…', fraction: 0 });
      try {
        const result = await task({
          signal: controller.signal,
          onStage: (stage) => setWorking({ what, stage: stage.message, fraction: stage.fraction }),
        });
        await refresh();
        return result;
      } catch (failure) {
        if (!(failure instanceof Cancelled)) {
          setError(failure instanceof ImportError || failure instanceof CloudError ? failure.message : 'Something went wrong.');
        }
        return undefined;
      } finally {
        running.current = null;
        setWorking(null);
      }
    },
    [refresh],
  );

  /**
   * Adds a song file, charted the usual way: the name from the file, the tempo found from the music,
   * a normal number of tiles. Anything else is a matter of tuning it afterwards. Resolves with its
   * chart, or undefined if it failed or was cancelled.
   */
  const add = useCallback(
    async (file: File): Promise<ChartFile | undefined> => {
      setAdded(null);
      const chart = await run(`Adding ${file.name}`, (job) => addSong(file, {}, job));
      if (chart) setAdded(chart);
      return chart;
    },
    [run],
  );

  /** Works the tiles out again; resolves with the new chart, or undefined if it failed or was cancelled. */
  const rechart = useCallback(
    (id: string, options: RechartOptions) => run('Re-charting', (job) => rechartSong(id, options, job)),
    [run],
  );
  /** Saves a new name or sync; resolves with the song as saved, or undefined if that failed. */
  const tune = useCallback((id: string, options: TuneOptions) => run('Saving', (job) => tuneSong(id, options, job)), [run]);
  const remove = useCallback(
    async (id: string) => {
      const gone = await run('Removing', async (job) => {
        await removeSong(id, job);
        return true;
      });
      if (gone) setAdded((old) => (old?.id === id ? null : old));
      return gone === true;
    },
    [run],
  );

  /** Saves the song, its audio and its tuning as one file, to be added on another device. */
  const save = useCallback(
    async (id: string) => {
      const file = await run('Saving the song file', async () => exportSong(id));
      if (file) saveToDevice(file.blob, file.filename);
    },
    [run],
  );

  /** Publishes the song for everyone, or brings what is published up to date with it. Resolves with the song as kept here now, or undefined if it failed or was cancelled. */
  const publish = useCallback(
    (id: string) =>
      run('Publishing', (job) =>
        viaCloud(async () =>
          publishSong(id, await getSongStore(), await backend.catalog(), {
            signal: job.signal,
            progress: (fraction) => job.onStage?.({ message: 'Uploading the audio', fraction: 0.05 + 0.9 * fraction }),
          }),
        ),
      ),
    [run, backend],
  );

  /** Takes the song down for everyone (it stays here as a draft). */
  const unpublish = useCallback(
    (id: string) => run('Taking the song down', () => viaCloud(async () => unpublishSong(id, await getSongStore(), await backend.catalog()))),
    [run, backend],
  );

  const cancel = useCallback(() => running.current?.abort(), []);
  const dismiss = useCallback(() => {
    setError(null);
    setAdded(null);
  }, []);

  return { working, error, added, add, rechart, tune, remove, save, publish, unpublish, cancel, dismiss };
}
