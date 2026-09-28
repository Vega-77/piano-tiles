import { useEffect, useRef, useState } from 'react';
import { GAME_OVER_REVEAL_MS } from '../config';

const BUTTON_CLASS =
  'rounded-full bg-white px-12 py-4 text-xl font-bold text-zinc-950 shadow-lg transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white active:scale-95';

interface MenuOverlayProps {
  highScore: number;
  onStart: () => void;
}

export function MenuOverlay({ highScore, onStart }: MenuOverlayProps) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-8 bg-zinc-950/90 px-8 text-center text-white">
      <div>
        <h1 className="text-5xl font-extrabold tracking-tight">Piano Tiles</h1>
        <p className="mt-3 text-zinc-400">
          Tap the black tiles as they fall. Miss one, or tap a white tile, and it's over.
        </p>
      </div>
      <p className="text-sm uppercase tracking-widest text-zinc-500">
        Best <span className="ml-2 text-2xl font-bold tabular-nums text-white">{highScore}</span>
      </p>
      <button type="button" onClick={onStart} className={BUTTON_CLASS}>
        Play
      </button>
      <p className="hidden text-xs text-zinc-500 pointer-fine:block">Keyboard: D · F · J · K</p>
    </div>
  );
}

interface GameOverOverlayProps {
  score: number;
  highScore: number;
  isNewBest: boolean;
  onRestart: () => void;
}

export function GameOverOverlay({ score, highScore, isNewBest, onRestart }: GameOverOverlayProps) {
  // Hold the panel back briefly so the player can see what went wrong, and so a
  // frantic last tap can't land on the restart button.
  const [ready, setReady] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), GAME_OVER_REVEAL_MS);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (ready) buttonRef.current?.focus();
  }, [ready]);

  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-zinc-950/75 px-8 text-center text-white transition-opacity duration-300 ${
        ready ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <h2 className="text-lg font-semibold uppercase tracking-[0.3em] text-zinc-400">Game over</h2>
      <p className="text-8xl font-extrabold tabular-nums">{score}</p>
      {isNewBest ? (
        <p className="rounded-full bg-amber-400 px-4 py-1 text-sm font-bold uppercase tracking-widest text-zinc-950">
          New best!
        </p>
      ) : (
        <p className="text-sm uppercase tracking-widest text-zinc-500">
          Best <span className="ml-2 text-xl font-bold tabular-nums text-white">{highScore}</span>
        </p>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={onRestart}
        disabled={!ready}
        className={`${BUTTON_CLASS} mt-4`}
      >
        Play again
      </button>
    </div>
  );
}
