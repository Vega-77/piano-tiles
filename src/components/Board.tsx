import type { PointerEvent, RefObject } from 'react';
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
  return (
    <div
      ref={boardRef}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
