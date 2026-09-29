import type { CSSProperties } from 'react';
import type { SongStats, StatsMap } from '../game/storage';
import { beatRows } from '../songs/notation';
import { DIFFICULTY_LABELS, songBars, songFeatures, songSeconds } from '../songs/songs';
import type { Song } from '../types';

const themeOf = (song: Song) => ({ '--hue': song.hue, '--hue2': song.hue2 }) as CSSProperties;

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A miniature of the song's opening: its first few beats as tiles. */
function SongCover({ song }: { song: Song }) {
  const rowsShown = 8;
  const cells: { key: string; lane: number; top: number; rows: number; hold: boolean }[] = [];
  let bottom = rowsShown;
  for (let i = 0; i < song.beats.length && bottom > 0; i++) {
    const beat = song.beats[i];
    const rows = beatRows(beat);
    const top = bottom - rows;
    if (beat.type === 'double') {
      const lanes = i % 2 ? [1, 3] : [0, 2];
      for (const lane of lanes) cells.push({ key: `${i}-${lane}`, lane, top, rows: 1, hold: false });
    } else if (beat.type !== 'rest') {
      cells.push({ key: String(i), lane: (i * 3 + 1) % 4, top, rows, hold: beat.type === 'hold' });
    }
    bottom = top;
  }

  return (
    <div
      className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/20"
      style={{ background: 'linear-gradient(160deg, hsl(var(--hue) 60% 14%), hsl(var(--hue2) 70% 8%))' }}
      aria-hidden
    >
      <div className="cover-strip absolute inset-x-0 top-0 h-[200%]">
        {[0, 1].map((copy) => (
          <div key={copy} className="relative h-1/2 w-full">
            {cells.map((cell) => (
              <div
                key={cell.key}
                className="absolute p-px"
                style={{
                  left: `${cell.lane * 25}%`,
                  width: '25%',
                  top: `${(cell.top / rowsShown) * 100}%`,
                  height: `${(cell.rows / rowsShown) * 100}%`,
                }}
              >
                <div
                  className="h-full w-full rounded-[3px]"
                  style={{
                    background: cell.hold
                      ? 'linear-gradient(160deg, hsl(50 100% 68%), hsl(24 96% 52%))'
                      : 'linear-gradient(160deg, hsl(var(--hue) 95% 70%), hsl(var(--hue2) 90% 52%))',
                  }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DifficultyPips({ level }: { level: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className="h-2 w-2 rounded-full"
          style={{
            background: n <= level ? 'hsl(var(--hue) 100% 68%)' : 'hsl(0 0% 100% / 0.18)',
            boxShadow: n <= level ? '0 0 6px hsl(var(--hue) 100% 60% / 0.8)' : undefined,
          }}
        />
      ))}
    </span>
  );
}

function Badge({ children, tone }: { children: string; tone: 'double' | 'hold' }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider"
      style={
        tone === 'hold'
          ? { background: 'hsl(40 100% 55% / 0.2)', color: 'hsl(45 100% 75%)' }
          : { background: 'hsl(var(--hue) 100% 60% / 0.2)', color: 'hsl(var(--hue) 100% 82%)' }
      }
    >
      {children}
    </span>
  );
}

interface SongCardProps {
  song: Song;
  index: number;
  stats: SongStats | undefined;
  selected: boolean;
  onSelect: () => void;
}

function SongCard({ song, index, stats, selected, onSelect }: SongCardProps) {
  const best = stats?.best ?? 0;
  const plays = stats?.plays ?? 0;
  const features = songFeatures(song);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="song-card card-in flex w-full gap-3 rounded-2xl p-3 text-left text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      style={{ ...themeOf(song), animationDelay: `${index * 70}ms` }}
    >
      <SongCover song={song} />

      <div className="min-w-0 flex-1">
        <h3 className="text-[0.95rem] font-bold leading-tight">{song.title}</h3>
        <p className="text-xs text-white/55">{song.composer}</p>

        <div className="mt-1.5 flex items-center gap-2 text-xs font-semibold">
          <DifficultyPips level={song.difficulty} />
          <span style={{ color: 'hsl(var(--hue) 100% 78%)' }}>{DIFFICULTY_LABELS[song.difficulty]}</span>
        </div>

        <p className="mt-1 text-[0.7rem] tabular-nums text-white/60">
          {song.bpm} BPM · {songBars(song)} bars · {formatDuration(songSeconds(song))}
        </p>

        {(features.doubles || features.holds) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {features.doubles && <Badge tone="double">Doubles</Badge>}
            {features.holds && <Badge tone="hold">Holds</Badge>}
          </div>
        )}

        {selected && <p className="rise-in mt-2 text-xs leading-snug text-white/75">{song.description}</p>}
      </div>

      <div className="flex shrink-0 flex-col items-end text-right">
        <span className="text-[0.6rem] font-bold uppercase tracking-widest text-white/45">Best</span>
        <span className="text-xl font-black leading-none tabular-nums">{best.toLocaleString()}</span>
        <span className="mt-1 text-[0.65rem] text-white/45">
          {plays} {plays === 1 ? 'play' : 'plays'}
        </span>
        {stats && stats.bestChain > 0 && (
          <span className="text-[0.65rem] text-white/45">chain {stats.bestChain}</span>
        )}
        {stats && stats.bestLaps > 0 && (
          <span className="text-[0.65rem] text-white/45">
            {stats.bestLaps} {stats.bestLaps === 1 ? 'lap' : 'laps'}
          </span>
        )}
      </div>
    </button>
  );
}

interface SongSelectProps {
  songs: readonly Song[];
  stats: StatsMap;
  selectedId: string;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
}

export function SongSelect({ songs, stats, selectedId, onSelect, onPlay }: SongSelectProps) {
  const selected = songs.find((song) => song.id === selectedId) ?? songs[0];

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-black/50 text-white">
      <header className="rise-in px-5 pb-3 pt-[max(1.5rem,env(safe-area-inset-top))] text-center">
        <h1 className="title-gradient text-4xl font-black tracking-tight">Piano Tiles</h1>
        <p className="mt-1 text-sm text-white/60">Choose a song</p>
      </header>

      <ul className="song-list flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {songs.map((song, index) => (
          <li key={song.id}>
            <SongCard
              song={song}
              index={index}
              stats={stats[song.id]}
              selected={song.id === selected.id}
              onSelect={() => onSelect(song.id)}
            />
          </li>
        ))}
      </ul>

      <footer className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        <button
          type="button"
          onClick={() => onPlay(selected.id)}
          className="btn-primary flex w-full items-center justify-center gap-2 rounded-full px-6 py-4 text-lg font-extrabold text-white"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 fill-current" aria-hidden>
            <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" />
          </svg>
          <span className="truncate">Play {selected.title}</span>
        </button>
        <p className="mt-2 hidden text-center text-xs text-white/40 pointer-fine:block">
          Keyboard: D · F · J · K &nbsp;·&nbsp; Esc to pause
        </p>
      </footer>
    </div>
  );
}
