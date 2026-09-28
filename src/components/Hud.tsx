import { COMBO_MAX_MULTIPLIER, COMBO_STEP } from '../config';

interface HudProps {
  title: string;
  score: number;
  /** Consecutive perfects, and the points multiplier they have earned. */
  combo: number;
  comboMultiplier: number;
  /** 0-based lap of the song, and how much faster than lap 1 the tiles now fall. */
  lap: number;
  speedMultiplier: number;
  /** 0–1 through the current lap of the song. */
  progress: number;
  onPause: () => void;
}

export function Hud({ title, score, combo, comboMultiplier, lap, speedMultiplier, progress, onPause }: HudProps) {
  const maxed = comboMultiplier >= COMBO_MAX_MULTIPLIER;
  // How far through the current chain step, for the little meter under the multiplier.
  const step = maxed ? 1 : (combo % COMBO_STEP) / COMBO_STEP;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
      <div className="h-1 w-full bg-white/10">
        <div
          className="progress-fill h-full rounded-r-full transition-[width] duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="flex items-start gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={onPause}
            aria-label="Pause"
            className="pointer-events-auto grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/20 transition active:scale-90"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M7 4h4v16H7zM13 4h4v16h-4z" />
            </svg>
          </button>
          <span className="hidden min-w-0 truncate rounded-full bg-black/50 px-3 py-1 text-xs font-semibold text-white/85 ring-1 ring-white/15 min-[400px]:block">
            {title}
          </span>
        </div>

        <div className="flex flex-col items-center">
          {/* Changing the key remounts the element, which replays its pop animation. */}
          <span
            key={score}
            className="bump rounded-full bg-black/65 px-5 py-1 text-3xl font-black tabular-nums text-white ring-1 ring-white/25"
          >
            {score.toLocaleString()}
          </span>
          <div
            key={comboMultiplier}
            className={`${comboMultiplier > 1 ? 'flash' : ''} mt-1.5 flex items-center gap-2 rounded-full bg-black/55 px-3 py-0.5 text-xs font-bold text-white ring-1 ring-white/15`}
          >
            <span className="tabular-nums" style={{ color: comboMultiplier > 1 ? 'hsl(48 100% 70%)' : undefined }}>
              ×{comboMultiplier}
            </span>
            <span className="h-1 w-10 overflow-hidden rounded-full bg-white/15" aria-hidden>
              <span className="block h-full rounded-full bg-[hsl(48_100%_65%)]" style={{ width: `${step * 100}%` }} />
            </span>
            <span className="tabular-nums text-white/70">{combo}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 justify-end">
          <span
            key={lap}
            className={`${lap > 0 ? 'flash' : ''} rounded-full bg-black/50 px-3 py-1 text-xs font-bold tabular-nums text-white/90 ring-1 ring-white/15`}
          >
            Lap {lap + 1} · ×{speedMultiplier.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
