import { useEffect, useState, type ReactNode } from 'react';
import { MAX_NUDGE, type ChartFile } from '../songs/chart';
import { DENSITIES, LENGTHS, LENGTH_SECONDS, type Density, type Length, type RechartOptions, type TuneOptions } from '../songs/importer';
import { DIFFICULTY_LABELS } from '../songs/songs';
import type { Song } from '../types';

const DENSITY_LABELS: Record<Density, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const DENSITY_HINTS: Record<Density, string> = {
  easy: 'A steady stream of tiles, with room to breathe and doubles now and then.',
  medium: 'Lots of tiles, close together, with plenty of doubles.',
  hard: 'Tiles on nearly every hit in the music, and doubles all the way through.',
};

const LENGTH_LABELS: Record<Length, string> = { short: 'Short', medium: 'Medium', long: 'Long' };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

/** What a length setting means, in words. */
function lengthHint(length: Length): string {
  const { min, max } = LENGTH_SECONDS[length];
  return `A song longer than ${max} s is stopped at a bar line between ${min} and ${max} s, at the end of a phrase where it can.`;
}

/** What the saved chart of this song plays: all of it, or up to where it was stopped. */
function playsNow(song: Song): string {
  const recording = song.recording;
  if (!recording) return '';
  if (recording.end === undefined) return `Now: plays the whole song (${clock(recording.duration)}).`;
  return `Now: plays ${clock(recording.end)} of ${clock(recording.duration)}.`;
}

/** The slider stops short of the file's limit: a song that far off wants a different tempo, not a nudge. */
const SLIDER_MS = 250;
const MAX_NUDGE_MS = MAX_NUDGE * 1000;

interface TuneScreenProps {
  /** A song added on this device. Key the screen on it, so its fields start again for another song. */
  song: Song;
  busy: boolean;
  /** Whether someone is signed in, so the song is kept in their cloud and removing it removes it there too. */
  synced?: boolean;
  /** Progress, or what went wrong, for what is being done to the song. */
  status?: ReactNode;
  onTune: (id: string, options: TuneOptions) => Promise<ChartFile | undefined>;
  onRechart: (id: string, options: RechartOptions) => Promise<ChartFile | undefined>;
  /** Saves the song, audio included, as a file that can be added on another device. */
  onSave: (id: string) => void;
  onRemove: (id: string) => void;
  /** Plays the song, to hear whether the change helped. */
  onPlay: (id: string) => void;
  onBack: () => void;
}

const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));

const field =
  'w-full rounded-lg bg-black/40 px-3 py-2.5 text-sm text-white ring-1 ring-white/20 placeholder:text-white/30 focus:outline-2 focus:outline-white disabled:opacity-50';
const small = 'btn-ghost rounded-full px-4 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/[0.06] p-4 ring-1 ring-white/10">
      <h2 className="mb-3 text-sm font-extrabold text-white">{title}</h2>
      <div className="space-y-3 text-xs text-white/70">{children}</div>
    </section>
  );
}

/**
 * Where a song added on this device is put right: give it a name, move the music against the
 * tiles, give it a tempo by hand, ask for more or fewer tiles, take it to another device, or take
 * it out. A screen of its own, so it is clear whether you are picking a song or tuning one.
 */
export function TuneScreen({ song, busy, synced = false, status, onTune, onRechart, onSave, onRemove, onPlay, onBack }: TuneScreenProps) {
  const info = song.imported;
  const savedNudge = Math.round((info?.nudge ?? 0) * 1000);
  const savedLevel = info?.level ?? 'medium';
  const savedLength = info?.length ?? 'medium';
  const [title, setTitle] = useState(song.title);
  const [nudge, setNudge] = useState(savedNudge);
  // The tempo as found can have a long tail (99.996); show it to a tenth. Only a typed change counts as by hand.
  const shownBpm = String(Math.round(song.bpm * 10) / 10);
  const [bpm, setBpm] = useState(shownBpm);
  const [level, setLevel] = useState<Density>(savedLevel);
  const [length, setLength] = useState<Length>(savedLength);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // What is saved changed (a save or a re-chart came back): start the fields from it again.
  const saved = `${song.title}|${song.bpm}|${savedNudge}|${savedLevel}|${savedLength}|${song.recording?.end ?? ''}`;
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setTitle(song.title);
    setNudge(savedNudge);
    setBpm(shownBpm);
    setLevel(savedLevel);
    setLength(savedLength);
    setConfirming(false);
  }

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  if (!info) return null;

  const trimmed = title.trim();
  const bpmValue = Number(bpm);
  const bpmOk = bpm.trim() !== '' && Number.isFinite(bpmValue) && bpmValue >= 40 && bpmValue <= 300;
  const bpmChanged = bpmOk && bpmValue !== Number(shownBpm);
  const nudgeOk = Number.isFinite(nudge) && Math.abs(nudge) <= MAX_NUDGE_MS;
  const saveDirty = (trimmed !== '' && trimmed !== song.title) || nudge !== savedNudge;

  const save = async () => {
    const options: TuneOptions = {};
    if (trimmed !== '' && trimmed !== song.title) options.title = trimmed;
    if (nudge !== savedNudge) options.nudgeMs = nudge;
    setNotice(null);
    if (await onTune(song.id, options)) setNotice('Saved.');
  };

  const rechart = async (options: RechartOptions) => {
    setNotice(null);
    const chart = await onRechart(song.id, options);
    if (chart) setNotice(`Re-charted: ${chart.analysis?.tiles ?? 'new'} tiles.`);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-black/60 text-white">
      <header className="px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onBack} className="btn-ghost flex items-center gap-1 rounded-full py-1.5 pl-2.5 pr-4 text-sm font-bold">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 5-7 7 7 7" />
          </svg>
          Songs
        </button>
        <div className="rise-in mt-3 text-center">
          <p className="text-[0.65rem] font-bold uppercase tracking-widest text-white/50">Tune song</p>
          <h1 className="title-gradient truncate text-2xl font-black leading-tight">{song.title}</h1>
          <p className="mt-0.5 text-xs text-white/55">
            {Math.round(song.bpm)} BPM · {DIFFICULTY_LABELS[song.difficulty]}
          </p>
        </div>
      </header>

      <div className="song-list flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {info.warnings.map((warning) => (
          <p key={warning} className="rounded-2xl bg-amber-400/10 px-4 py-3 text-xs leading-snug text-amber-200 ring-1 ring-amber-300/30">
            {warning}
          </p>
        ))}

        <Section title="Name and sync">
          <label className="block">
            <span className="mb-1 block font-semibold text-white/85">Name</span>
            <input type="text" value={title} maxLength={80} disabled={busy} onChange={(e) => setTitle(e.target.value)} className={field} />
          </label>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="nudge" className="font-semibold text-white/85">
                Sync
              </label>
              <output className="tabular-nums text-white/60">{nudge === 0 ? 'as analysed' : `${signed(nudge)} ms`}</output>
            </div>
            <input
              id="nudge"
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
          </div>

          <div className="flex gap-2">
            <button type="button" className={small} disabled={busy || !saveDirty || !nudgeOk || trimmed === ''} onClick={save}>
              Save
            </button>
            {nudge !== 0 && (
              <button type="button" className={small} disabled={busy} onClick={() => setNudge(0)}>
                Reset sync
              </button>
            )}
          </div>
        </Section>

        <Section title="Tempo and tiles">
          <div>
            <label htmlFor="tempo" className="mb-1 block font-semibold text-white/85">
              Tempo
            </label>
            <div className="flex items-center gap-2">
              <input
                id="tempo"
                type="number"
                inputMode="decimal"
                min={40}
                max={300}
                step="any"
                value={bpm}
                disabled={busy}
                onChange={(e) => setBpm(e.target.value)}
                className={`${field} max-w-32`}
              />
              <span className="text-white/55">BPM {info.manualBpm ? '(set by hand)' : '(found from the music)'}</span>
            </div>
            <p className="mt-1 leading-snug text-white/45">
              If the tiles keep drifting off the music, the tempo is probably wrong, often half or double. Type the right one and re-chart.
            </p>
          </div>

          <div>
            <span className="mb-1 block font-semibold text-white/85">How many tiles</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label="How many tiles">
              {DENSITIES.map((density) => (
                <button
                  key={density}
                  type="button"
                  role="radio"
                  aria-checked={level === density}
                  disabled={busy}
                  onClick={() => setLevel(density)}
                  className={`flex-1 rounded-lg py-2 text-center text-sm font-bold ring-1 ring-white/15 disabled:opacity-50 ${
                    level === density ? 'bg-white/90 text-black' : 'bg-white/10'
                  }`}
                >
                  {DENSITY_LABELS[density]}
                </button>
              ))}
            </div>
            <p className="mt-1 leading-snug text-white/45">{DENSITY_HINTS[level]}</p>
          </div>

          <div>
            <span className="mb-1 block font-semibold text-white/85">How long</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label="How long">
              {LENGTHS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={length === option}
                  disabled={busy}
                  onClick={() => setLength(option)}
                  className={`flex-1 rounded-lg py-2 text-center text-sm font-bold ring-1 ring-white/15 disabled:opacity-50 ${
                    length === option ? 'bg-white/90 text-black' : 'bg-white/10'
                  }`}
                >
                  {LENGTH_LABELS[option]}
                  <span className="block text-[0.6rem] font-semibold opacity-70">
                    {LENGTH_SECONDS[option].min}–{LENGTH_SECONDS[option].max} s
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-1 leading-snug text-white/45">
              {lengthHint(length)} {playsNow(song)}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={small}
              disabled={busy || !bpmOk}
              onClick={() => rechart(bpmChanged ? { density: level, length, bpm: bpmValue } : { density: level, length })}
            >
              Re-chart
            </button>
            {info.manualBpm && (
              <button type="button" className={small} disabled={busy} onClick={() => rechart({ density: level, length, auto: true })}>
                Find the tempo again
              </button>
            )}
          </div>
          <p className="leading-snug text-white/45">Re-charting listens to the song again and places the tiles afresh.</p>
        </Section>

        <Section title="On another device">
          <p className="leading-snug text-white/55">
            {synced
              ? 'This song is kept in your account, so it turns up on your other devices once you sign in there. A song file is a backup, or a way to move it without signing in.'
              : 'This song lives in this browser only. Sign in on the song list to sync it, or save it as a file and choose that file with “Add your own song” on the other device.'}
          </p>
          <button type="button" className={small} disabled={busy} onClick={() => onSave(song.id)}>
            Save song file
          </button>
        </Section>

        <Section title="Remove">
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-white/80">
                {synced
                  ? 'Delete this song and its audio from this device and from your account, so it goes from your other devices too?'
                  : 'Delete this song and its audio from this device?'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onRemove(song.id);
                }}
                className="rounded-full bg-red-500/80 px-4 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-40"
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
        </Section>
      </div>

      {notice && (
        <p role="status" className="rise-in mx-4 mb-2 rounded-2xl bg-emerald-500/15 px-4 py-2 text-center text-sm font-semibold text-emerald-100 ring-1 ring-emerald-400/40">
          {notice}
        </p>
      )}
      {status}

      <footer className="flex gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        <button
          type="button"
          onClick={onBack}
          className="btn-ghost shrink-0 rounded-full px-5 py-4 text-base font-bold text-white"
        >
          Done
        </button>
        <button
          type="button"
          onClick={() => onPlay(song.id)}
          disabled={busy}
          className="btn-primary flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full px-5 py-4 text-base font-extrabold text-white disabled:cursor-wait disabled:opacity-70"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 fill-current" aria-hidden>
            <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
          </svg>
          <span className="truncate">Try it</span>
        </button>
      </footer>
    </div>
  );
}
