import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartFile } from '../songs/chart';
import {
  CAN_IMPORT,
  checkTools,
  importSong,
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

export interface ToolsStatus {
  available: boolean;
  message?: string;
}

/** What is being worked on, and the latest thing the analyser said about it. */
export interface Working {
  what: string;
  stage: string;
}

/** The choices for the next song to be added (kept here so a file dropped anywhere on the menu uses them). */
export interface ImportChoices {
  title: string;
  bpm: string;
  density: Density;
}

const DEFAULT_CHOICES: ImportChoices = { title: '', bpm: '', density: 'normal' };

/**
 * Adding, tuning and removing songs through the dev server, one job at a time. `refresh` reads
 * the library again once a job has changed it.
 */
export function useImporter(refresh: () => Promise<void>) {
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ChartFile | null>(null);
  const [choices, setChoices] = useState<ImportChoices>(DEFAULT_CHOICES);
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!CAN_IMPORT) return;
    let current = true;
    void checkTools().then((status) => {
      if (current) setTools(status);
    });
    return () => {
      current = false;
    };
  }, []);

  const run = useCallback(
    async <T>(what: string, task: (job: Job) => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      const controller = new AbortController();
      running.current = controller;
      setError(null);
      setWorking({ what, stage: 'Sending…' });
      try {
        const result = await task({ signal: controller.signal, onStage: (stage) => setWorking({ what, stage: stage.message }) });
        await refresh();
        return result;
      } catch (failure) {
        setError(failure instanceof ImportError ? failure.message : 'Something went wrong.');
        return undefined;
      } finally {
        running.current = null;
        setWorking(null);
      }
    },
    [refresh],
  );

  /** Adds a song file, using the current choices. Resolves with its chart, or undefined if it failed. */
  const add = useCallback(
    async (file: File): Promise<ChartFile | undefined> => {
      if (!tools?.available) {
        setError(tools?.message ?? 'The song tools are not ready.');
        return undefined;
      }
      const options: ImportOptions = { title: choices.title, density: choices.density };
      const bpm = Number(choices.bpm);
      if (choices.bpm.trim() !== '' && Number.isFinite(bpm)) options.bpm = bpm;
      setAdded(null);
      const chart = await run(`Adding ${file.name}`, (job) => importSong(file, options, job));
      if (chart) {
        setAdded(chart);
        setChoices((old) => ({ ...old, title: '', bpm: '' })); // (the density carries over)
      }
      return chart;
    },
    [tools, choices, run],
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

  const cancel = useCallback(() => running.current?.abort(), []);
  const dismiss = useCallback(() => {
    setError(null);
    setAdded(null);
  }, []);

  return { tools, working, error, added, choices, setChoices, add, rechart, tune, remove, cancel, dismiss };
}
