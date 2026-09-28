interface HudProps {
  title: string;
  score: number;
  speedMultiplier: number;
  /** 0–1 through the current lap of the song. */
  progress: number;
}

export function Hud({ title, score, speedMultiplier, progress }: HudProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
      <div className="h-1 w-full bg-white/10">
        <div
          className="progress-fill h-full rounded-r-full transition-[width] duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 flex-1 justify-start">
          <span className="truncate rounded-full bg-black/50 px-3 py-1 text-xs font-semibold text-white/85 ring-1 ring-white/15">
            {title}
          </span>
        </div>
        {/* Changing the key remounts the element, which replays its pop animation. */}
        <span
          key={score}
          className="bump rounded-full bg-black/65 px-5 py-1 text-3xl font-black tabular-nums text-white ring-1 ring-white/25"
        >
          {score}
        </span>
        <div className="flex min-w-0 flex-1 justify-end">
          <span
            key={speedMultiplier}
            className={`${speedMultiplier > 1 ? 'flash' : ''} rounded-full bg-black/50 px-3 py-1 text-sm font-bold tabular-nums text-white/90 ring-1 ring-white/15`}
          >
            ×{speedMultiplier.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}
