import { useEffect, type PointerEvent, type RefObject } from 'react';
import { LANES } from '../config';

interface BoardProps {
  boardRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  fxRef: RefObject<HTMLCanvasElement | null>;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
}

const LANE_INDEXES = Array.from({ length: LANES }, (_, i) => i);

/** Lane dividers, an empty layer the game engine fills with tiles, and the particle canvas on top. */
export function Board({ boardRef, layerRef, fxRef, onPointerDown, onPointerUp }: BoardProps) {
  // The fingers on the board are the game's input, so the browser gets no say in them: no zoom, scroll, long-press
  // menu or text selection may start while two of them are down. (`touch-action` covers most browsers; this the rest.)
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const keep = (e: TouchEvent) => e.preventDefault();
    board.addEventListener('touchstart', keep, { passive: false });
    return () => board.removeEventListener('touchstart', keep);
  }, [boardRef]);

  return (
    <div
      ref={boardRef}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      // (No onPointerCancel: the browser cancelling a touch is not the player letting go. A hold that loses its finger
      // that way still runs to its end, or ends when the next tile is tapped, instead of being dropped early.)
      onContextMenu={(e) => e.preventDefault()}
      className="absolute inset-0 touch-none select-none"
    >
      <div className="pointer-events-none absolute inset-0 flex bg-gradient-to-b from-transparent to-white/[0.05]" aria-hidden>
        {LANE_INDEXES.map((i) => (
          <div key={i} className="h-full flex-1 border-r border-white/10 odd:bg-white/[0.025] last:border-r-0" />
        ))}
      </div>
      {/* No React children here: the engine owns everything inside this node. */}
      <div ref={layerRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      <canvas ref={fxRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
    </div>
  );
}
