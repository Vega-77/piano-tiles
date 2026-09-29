import { useState } from 'react';
import { MAX_NUDGE } from '../songs/chart';
import { DENSITIES, type Density, type RechartOptions, type TuneOptions } from '../songs/importer';
import type { Song } from '../types';

const DENSITY_LABELS: Record<Density, string> = { easy: 'Easy', normal: 'Normal', hard: 'Busy' };

/** The slider stops short of the file's limit: a song that far off wants a different tempo, not a nudge. */
const SLIDER_MS = 250;
const MAX_NUDGE_MS = MAX_NUDGE * 1000;

interface TunePanelProps {
  song: Song;
  busy: boolean;
  onTune: (id: string, options: TuneOptions) => void;
  onRechart: (id: string, options: RechartOptions) => void;
  onRemove: (id: string) => void;
}

const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));

/**
 * Fixes for an imported song that doesn't feel right: move the music against the tiles, give it
 * a tempo by hand, ask for more or fewer tiles, or take it out. Key it on the song. After a save
 * the fields start again from what is on disk, but the panel itself stays open for the next try.
 */
export function TunePanel({ song, busy, onTune, onRechart, onRemove }: TunePanelProps) {
  const info = song.imported;
  const savedNudge = Math.round((info?.nudge ?? 0) * 1000);
  const savedLevel = info?.level ?? 'normal';
  const [title, setTitle] = useState(song.title);
  const [nudge, setNudge] = useState(savedNudge);
  const [bpm, setBpm] = useState(String(song.bpm));
  const [level, setLevel] = useState<Density>(savedLevel);
  const [confirming, setConfirming] = useState(false);

  // What is saved changed (a save or a re-chart came back): start the fields from it again.
  const saved = `${song.title}|${song.bpm}|${savedNudge}|${savedLevel}`;
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setTitle(song.title);
    setNudge(savedNudge);
    setBpm(String(song.bpm));
    setLevel(savedLevel);
    setConfirming(false);
  }

  if (!info) return null;

  const trimmed = title.trim();
  const bpmValue = Number(bpm);
  const bpmOk = bpm.trim() !== '' && Number.isFinite(bpmValue) && bpmValue >= 40 && bpmValue <= 300;
  const bpmChanged = bpmOk && Math.abs(bpmValue - song.bpm) > 1e-9;
  const nudgeOk = Number.isFinite(nudge) && Math.abs(nudge) <= MAX_NUDGE_MS;
  const saveDirty = (trimmed !== '' && trimmed !== song.title) || nudge !== savedNudge;
  const rechartDirty = bpmChanged || level !== info.level;

  const save = () => {
    const options: TuneOptions = {};
    if (trimmed !== '' && trimmed !== song.title) options.title = trimmed;
    if (nudge !== savedNudge) options.nudgeMs = nudge;
    onTune(song.id, options);
  };

  const rechart = () => {
    const options: RechartOptions = { density: level };
    if (bpmChanged) options.bpm = bpmValue;
    onRechart(song.id, options);
  };

  const field =
    'w-full rounded-lg bg-black/40 px-3 py-2 text-sm text-white ring-1 ring-white/20 placeholder:text-white/30 focus:outline-2 focus:outline-white disabled:opacity-50';
  const small = 'btn-ghost rounded-full px-3 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <details className="rise-in mt-2 rounded-2xl bg-black/30 px-3 py-2 text-xs text-white/75 ring-1 ring-white/15">
      <summary className="cursor-pointer select-none font-semibold text-white/90">
        Tune this song
        {info.warnings.length > 0 && <span className="ml-2 text-amber-300">check the beat</span>}
      </summary>

      <div className="mt-3 space-y-4 pb-1">
        {info.warnings.map((warning) => (
          <p key={warning} className="rounded-lg bg-amber-400/10 px-2 py-1.5 leading-snug text-amber-200">
            {warning}
          </p>
        ))}

        <label className="block">
          <span className="mb-1 block font-semibold text-white/85">Name</span>
          <input type="text" value={title} maxLength={80} disabled={busy} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>

        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <label htmlFor={`nudge-${song.id}`} className="font-semibold text-white/85">
              Sync
            </label>
            <output className="tabular-nums text-white/60">{nudge === 0 ? 'as analysed' : `${signed(nudge)} ms`}</output>
          </div>
          <input
            id={`nudge-${song.id}`}
            type="range"
            min={-SLIDER_MS}
            max={SLIDER_MS}
            step={5}
            value={Math.max(-SLIDER_MS, Math.min(SLIDER_MS, nudge))}
            disabled={busy}
            onChange={(e) => setNudge(Number(e.target.value))}
            className="w-full accent-white"
          />
          <div className="flex justify-between text-[0.65rem] text-white/45">
            <span>tiles late</span>
            <span>tiles early</span>
          </div>
          <p className="mt-1 leading-snug text-white/45">
            Play the song. If the tiles reach the bar before the beat you hear, move this to the right; if after, to the left.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={small} disabled={busy || !saveDirty || !nudgeOk || trimmed === ''} onClick={save}>
              Save
            </button>
            {nudge !== 0 && (
              <button type="button" className={small} disabled={busy} onClick={() => setNudge(0)}>
                Reset sync
              </button>
            )}
          </div>
        </div>

        <div>
          <span className="mb-1 block font-semibold text-white/85">Tempo</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              min={40}
              max={300}
              step="any"
              value={bpm}
              disabled={busy}
              onChange={(e) => setBpm(e.target.value)}
              aria-label="Tempo in beats per minute"
              className={`${field} max-w-28`}
            />
            <span className="text-white/55">BPM {info.manualBpm ? '(set by hand)' : '(detected)'}</span>
          </div>
          <p className="mt-1 leading-snug text-white/45">
            If the tiles keep drifting off the music, the tempo is probably wrong, often half or double. Type the right one and re-chart.
          </p>

          <span className="mb-1 mt-3 block font-semibold text-white/85">How many tiles</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="How many tiles">
            {DENSITIES.map((density) => (
              <button
                key={density}
                type="button"
                role="radio"
                aria-checked={level === density}
                disabled={busy}
                onClick={() => setLevel(density)}
                className={`flex-1 rounded-lg py-1.5 text-center font-bold ring-1 ring-white/15 disabled:opacity-50 ${
                  level === density ? 'bg-white/90 text-black' : 'bg-white/10'
                }`}
              >
                {DENSITY_LABELS[density]}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={small} disabled={busy || !bpmOk || !rechartDirty} onClick={rechart}>
              Re-chart
            </button>
            {info.manualBpm && (
              <button
                type="button"
                className={small}
                disabled={busy}
                onClick={() => onRechart(song.id, { density: level, auto: true })}
              >
                Detect the tempo again
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 pt-3">
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-white/80">Delete this song and its audio?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onRemove(song.id);
                }}
                className="rounded-full bg-red-500/80 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-40"
              >
                Delete
              </button>
              <button type="button" className={small} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className={small} disabled={busy} onClick={() => setConfirming(true)}>
              Remove song…
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
