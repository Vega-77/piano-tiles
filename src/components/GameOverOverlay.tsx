import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CONTINUE_SCORE_COST, GAME_OVER_REVEAL_MS } from '../config';
import type { FailReason, GameOverResult } from '../game/engine';
import { DIFFICULTY_LABELS } from '../songs/songs';
import type { Song } from '../types';

/** Counts up from 0 to `target` with an ease-out, for the final score. */
function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-white/[0.07] px-2 py-2 ring-1 ring-white/10">
      <span className="text-lg font-black tabular-nums leading-none" style={{ color: tone }}>
        {value}
      </span>
      <span className="mt-1 text-[0.6rem] font-bold uppercase tracking-wider text-white/50">{label}</span>
    </div>
  );
}

const REASONS: Record<FailReason, string> = {
  miss: 'You missed a tile',
  early: 'You tapped too early: the tile was nowhere near the bar',
  wrong: 'You tapped a lane with no tile in it',
};

/** What ended the run, with how far off the tap was when it was one that missed. */
export function reasonText(result: Pick<GameOverResult, 'reason' | 'by'>): string {
  if (result.by === undefined) return REASONS[result.reason];
  return result.reason === 'early'
    ? `You tapped too early: the tile was still ${result.by} ms from the bar`
    : `You tapped ${result.by} ms too late`;
}

/** What continuing costs, in words: a share of the score is taken, and the chain starts over. */
export function offerText(score: number, kept: number): string {
  const share = Math.round(CONTINUE_SCORE_COST * 100);
  return `You keep ${kept.toLocaleString()} of your ${score.toLocaleString()} points (${share}% is taken), your chain starts over, and a count-in leads you back into the bar you fell in. This can only be done once per run.`;
}

interface GameOverOverlayProps {
  song: Song;
  score: number;
  best: number;
  result: GameOverResult | null;
  /** Under the stats: what the run did for the leaderboard (a name to ask for, or where it landed). */
  standing?: ReactNode;
  /** Take the offer to carry on (while the result has a score to go on with). */
  onContinue: () => void;
  /** Turn the offer down, which ends the run. */
  onFinish: () => void;
  onRestart: () => void;
  onMenu: () => void;
}

export function GameOverOverlay({ song, score, best, result, standing, onContinue, onFinish, onRestart, onMenu }: GameOverOverlayProps) {
  // Hold the panel back briefly so the player can see what went wrong, and so a
  // frantic last tap can't land on a button.
  const [ready, setReady] = useState(false);
  const restartRef = useRef<HTMLButtonElement>(null);
  const shownScore = useCountUp(ready ? score : 0);
  const stats = result?.stats;
  /** The score the run could go on with, while it still can: the run is not over until that is turned down. */
  const kept = result?.continueScore ?? null;

  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), GAME_OVER_REVEAL_MS);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (ready) restartRef.current?.focus();
  }, [ready, kept === null]);

  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col items-center overflow-y-auto bg-black/75 px-6 py-6 text-center text-white transition-opacity duration-500 ${
        ready ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {/* (`my-auto` centres it while it fits, and lets the panel scroll from its top when it doesn't) */}
      <div className="my-auto flex w-full flex-col items-center gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.35em] text-white/55">Game over</h2>
          <p className="mt-1 text-base font-bold" style={{ color: 'hsl(var(--hue) 100% 78%)' }}>
            {song.title}
          </p>
          <p className="text-xs text-white/45">{DIFFICULTY_LABELS[song.difficulty]}</p>
          {result && <p className="mx-auto mt-2 max-w-[17rem] text-xs text-rose-300/90">{reasonText(result)}</p>}
        </div>

        <p className="title-gradient text-7xl font-black tabular-nums leading-none">{shownScore.toLocaleString()}</p>

        {kept !== null ? (
          <>
            <div className="w-full rounded-2xl bg-white/[0.07] px-4 py-3 text-sm ring-1 ring-white/10">
              <p className="font-bold text-white">Carry on from where you fell?</p>
              <p className="mt-1 text-xs leading-snug text-white/60">{offerText(score, kept)}</p>
            </div>
            <div className="flex w-full flex-col gap-3">
              <button
                ref={restartRef}
                type="button"
                onClick={onContinue}
                disabled={!ready}
                className="btn-primary rounded-full px-10 py-4 text-lg font-extrabold text-white"
              >
                Continue with {kept.toLocaleString()}
              </button>
              <button
                type="button"
                onClick={onFinish}
                disabled={!ready}
                className="btn-ghost rounded-full px-10 py-3 text-base font-bold text-white/90"
              >
                No thanks, keep {score.toLocaleString()}
              </button>
            </div>
          </>
        ) : (
          <>
            {result?.isNewBest ? (
              <p className="badge-new-best rounded-full px-5 py-1.5 text-sm font-black uppercase tracking-widest text-zinc-950">
                New best!
              </p>
            ) : (
              <p className="text-sm uppercase tracking-widest text-white/50">
                Best <span className="ml-2 text-xl font-bold tabular-nums text-white">{best.toLocaleString()}</span>
              </p>
            )}

            {stats && (
              <div className="grid w-full grid-cols-3 gap-2">
                <Stat label="Perfect" value={stats.perfect} tone="hsl(48 100% 70%)" />
                <Stat label="Good" value={stats.good} tone="hsl(160 90% 65%)" />
                <Stat label="Ok" value={stats.ok} tone="hsl(215 90% 75%)" />
                <Stat label="Best chain" value={stats.maxChain} />
                <Stat label="Tiles" value={stats.tiles} />
                <Stat label="Laps" value={stats.laps} />
              </div>
            )}

            {standing}

            <div className="mt-1 flex w-full flex-col gap-3">
              <button
                ref={restartRef}
                type="button"
                onClick={onRestart}
                disabled={!ready}
                className="btn-primary rounded-full px-10 py-4 text-lg font-extrabold text-white"
              >
                Play again
              </button>
              <button
                type="button"
                onClick={onMenu}
                disabled={!ready}
                className="btn-ghost rounded-full px-10 py-3 text-base font-bold text-white/90"
              >
                Choose another song
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
