interface HudProps {
  score: number;
  speedMultiplier: number;
}

export function Hud({ score, speedMultiplier }: HudProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      <span className="rounded-full bg-zinc-950/85 px-5 py-1.5 text-3xl font-extrabold tabular-nums text-white ring-1 ring-white/25">
        {score}
      </span>
      <span className="rounded-full bg-zinc-950/70 px-3 py-1 text-sm font-semibold tabular-nums text-zinc-200 ring-1 ring-white/20">
        ×{speedMultiplier.toFixed(2)}
      </span>
    </div>
  );
}
