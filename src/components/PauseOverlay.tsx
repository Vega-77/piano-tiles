import { useEffect, useRef } from 'react';

interface PauseOverlayProps {
  onResume: () => void;
  onQuit: () => void;
}

export function PauseOverlay({ onResume, onQuit }: PauseOverlayProps) {
  const resumeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => resumeRef.current?.focus(), []);

  return (
    <div className="rise-in absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-black/70 px-8 text-center text-white">
      <h2 className="title-gradient text-5xl font-black tracking-tight">Paused</h2>
      <p className="max-w-[16rem] text-sm text-white/60">The music and the tiles are frozen until you resume.</p>
      <div className="flex w-full flex-col gap-3">
        <button
          ref={resumeRef}
          type="button"
          onClick={onResume}
          className="btn-primary rounded-full px-10 py-4 text-lg font-extrabold text-white"
        >
          Resume
        </button>
        <button type="button" onClick={onQuit} className="btn-ghost rounded-full px-10 py-3 text-base font-bold text-white/90">
          Quit to songs
        </button>
      </div>
    </div>
  );
}
