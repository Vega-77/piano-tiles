import { useCallback, useRef, useState } from 'react';
import type { ChartFile } from '../songs/chart';
import {
  addSong,
  Cancelled,
  exportSong,
  ImportError,
  rechartSong,
  removeSong,
  tuneSong,
  type Density,
  type ImportOptions,
  type Job,
  type RechartOptions,
  type TuneOptions,
} from '../songs/importer';

/** What is being worked on, the latest thing the analyser said about it, and how far along it is (0 to 1). */
export interface Working {
  what: string;
  stage: string;
  fraction: number;
}

/** The choices for the next song to be added (kept here so a file dropped anywhere on the menu uses them). */
export interface ImportChoices {
  title: string;
  bpm: string;
  density: Density;
}

const DEFAULT_CHOICES: ImportChoices = { title: '', bpm: '', density: 'normal' };

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

/**
 * Adding, tuning, exporting and removing songs, one job at a time, all inside this browser.
 * `refresh` reads the library again once a job has changed it.
 */
export function useImporter(refresh: () => Promise<void>) {
  const [working, setWorking] = useState<Working | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ChartFile | null>(null);
  const [choices, setChoices] = useState<ImportChoices>(DEFAULT_CHOICES);
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
          setError(failure instanceof ImportError ? failure.message : 'Something went wrong.');
        }
        return undefined;
      } finally {
        running.current = null;
        setWorking(null);
      }
    },
    [refresh],
  );

  /** Adds a song file, using the current choices. Resolves with its chart, or undefined if it failed or was cancelled. */
  const add = useCallback(
    async (file: File): Promise<ChartFile | undefined> => {
      const options: ImportOptions = { title: choices.title, density: choices.density };
      const bpm = Number(choices.bpm);
      if (choices.bpm.trim() !== '' && Number.isFinite(bpm)) options.bpm = bpm;
      setAdded(null);
      const chart = await run(`Adding ${file.name}`, (job) => addSong(file, options, job));
      if (chart) {
        setAdded(chart);
        setChoices((old) => ({ ...old, title: '', bpm: '' })); // (the density carries over)
      }
      return chart;
    },
    [choices, run],
  );

  const rechart = useCallback(
    (id: string, options: RechartOptions) => run('Re-charting', (job) => rechartSong(id, options, job)),
    [run],
  );
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

  const cancel = useCallback(() => running.current?.abort(), []);
  const dismiss = useCallback(() => {
    setError(null);
    setAdded(null);
  }, []);

  return { working, error, added, choices, setChoices, add, rechart, tune, remove, save, cancel, dismiss };
}
