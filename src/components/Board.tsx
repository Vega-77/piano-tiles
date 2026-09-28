import type { PointerEvent, RefObject } from 'react';
import { LANES } from '../config';

interface BoardProps {
  boardRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<HTMLDivElement | null>;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
}

const LANE_INDEXES = Array.from({ length: LANES }, (_, i) => i);

/** Lane dividers plus an empty layer that the game engine fills with tiles. */
export function Board({ boardRef, layerRef, onPointerDown }: BoardProps) {
  return (
    <div
      ref={boardRef}
      onPointerDown={onPointerDown}
      className="absolute inset-0 touch-none select-none"
    >
      <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
        {LANE_INDEXES.map((i) => (
          <div key={i} className="h-full flex-1 border-r border-zinc-300 last:border-r-0" />
        ))}
      </div>
      {/* No React children here: the engine owns everything inside this node. */}
      <div ref={layerRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
    </div>
  );
}
