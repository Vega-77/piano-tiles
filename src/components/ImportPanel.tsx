import { useRef, type ChangeEvent } from 'react';
import type { ImportChoices, ToolsStatus } from '../hooks/useImporter';
import { CAN_IMPORT, DENSITIES, MAX_UPLOAD_MB, type Density } from '../songs/importer';

/** Where the project's instructions for adding songs are, for a copy of the app that can't do it itself. */
export const ADDING_SONGS_URL = 'https://github.com/vega-77/piano-tiles#adding-songs';

/** What the file picker offers. (The analyser also reads anything else ffmpeg understands, and a dropped file isn't checked.) */
const ACCEPT = 'audio/*,video/*,.mp3,.mp4,.m4a,.wav,.ogg,.flac,.webm,.mov,.aac,.opus';

const DENSITY_LABELS: Record<Density, string> = { easy: 'Easy', normal: 'Normal', hard: 'Busy' };

interface ImportPanelProps {
  tools: ToolsStatus | null;
  busy: boolean;
  choices: ImportChoices;
  onChoices: (choices: ImportChoices) => void;
  onFile: (file: File) => void;
}

/** The way to add a song: a drop zone with its options. On a build that can't add songs, a pointer to how. */
export function ImportPanel({ tools, busy, choices, onChoices, onFile }: ImportPanelProps) {
  const input = useRef<HTMLInputElement>(null);

  if (!CAN_IMPORT) {
    return (
      <p className="rounded-2xl px-4 py-3 text-center text-xs leading-relaxed text-white/45 border border-dashed border-white/15">
        Songs can be added when the game runs on a computer with <code>npm run dev</code>.{' '}
        <a href={ADDING_SONGS_URL} target="_blank" rel="noreferrer" className="font-semibold text-white/70 underline">
          How
        </a>
      </p>
    );
  }

  if (!tools) {
    return <p className="px-4 py-3 text-center text-xs text-white/45">Checking the song tools…</p>;
  }

  if (!tools.available) {
    return (
      <div className="rounded-2xl bg-white/5 px-4 py-3 text-xs leading-relaxed text-white/70 ring-1 ring-white/15">
        <p className="font-semibold text-white/90">Adding songs needs one-time setup</p>
        <p className="mt-1">{tools.message ?? 'The song tools are not installed.'}</p>
        <p className="mt-1">
          Run <code className="rounded bg-white/10 px-1">npm run setup:songs</code>, then reload.
        </p>
      </div>
    );
  }

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // (so the same file can be picked again)
    if (file) onFile(file);
  };

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept={ACCEPT} onChange={chosen} className="hidden" tabIndex={-1} />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="flex w-full flex-col items-center gap-1 rounded-2xl px-4 py-4 text-center text-sm text-white/80 border-2 border-dashed border-white/25 transition hover:bg-white/5 hover:border-white/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        <span className="font-bold">Add a song</span>
        <span className="text-xs text-white/50">Drop an mp4 or an audio file anywhere, or click to choose (up to {MAX_UPLOAD_MB} MB)</span>
      </button>

      <details className="rounded-2xl bg-white/5 px-3 py-2 text-xs text-white/70 ring-1 ring-white/10">
        <summary className="cursor-pointer select-none font-semibold text-white/80">Options for the next song</summary>
        <div className="mt-2 space-y-3 pb-1">
          <label className="block">
            <span className="mb-1 block font-semibold text-white/80">Name</span>
            <input
              type="text"
              value={choices.title}
              maxLength={80}
              onChange={(event) => onChoices({ ...choices, title: event.target.value })}
              placeholder="From the file name"
              className="w-full rounded-lg bg-black/40 px-3 py-2 text-sm text-white ring-1 ring-white/20 placeholder:text-white/30 focus:outline-2 focus:outline-white"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold text-white/80">Tempo (BPM)</span>
            <input
              type="number"
              inputMode="decimal"
              min={40}
              max={300}
              step="any"
              value={choices.bpm}
              onChange={(event) => onChoices({ ...choices, bpm: event.target.value })}
              placeholder="Find it from the music"
              className="w-full rounded-lg bg-black/40 px-3 py-2 text-sm text-white ring-1 ring-white/20 placeholder:text-white/30 focus:outline-2 focus:outline-white"
            />
            <span className="mt-1 block text-white/45">Type it if you know it. It stops the analyser locking on to half or double time.</span>
          </label>
          <fieldset>
            <legend className="mb-1 font-semibold text-white/80">How many tiles</legend>
            <div className="flex gap-1.5">
              {DENSITIES.map((density) => (
                <label key={density} className="flex-1">
                  <input
                    type="radio"
                    name="density"
                    value={density}
                    checked={choices.density === density}
                    onChange={() => onChoices({ ...choices, density })}
                    className="peer sr-only"
                  />
                  <span className="block cursor-pointer rounded-lg bg-white/10 py-1.5 text-center font-bold ring-1 ring-white/15 peer-checked:bg-white/90 peer-checked:text-black peer-focus-visible:outline-2 peer-focus-visible:outline-white">
                    {DENSITY_LABELS[density]}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>
    </div>
  );
}
