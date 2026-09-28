import type { CSSProperties } from 'react';
import { Board } from './components/Board';
import { GameOverOverlay } from './components/GameOverOverlay';
import { Hud } from './components/Hud';
import { SongSelect } from './components/SongSelect';
import { useGame } from './hooks/useGame';
import { SONGS } from './songs/songs';

export default function App() {
  const { state, lastRun, stats, selectedId, setSelectedId, activeSong, refs, start, quit, handlePointerDown, handlePointerUp } =
    useGame();
  const theme = { '--hue': activeSong.hue, '--hue2': activeSong.hue2 } as CSSProperties;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-zinc-950">
      {/* Full-window animated backdrop, drawn by the effects layer. */}
      <canvas ref={refs.bgRef} className="absolute inset-0 h-full w-full" aria-hidden />

      <main className="relative flex h-dvh w-full items-center justify-center">
        {/* Portrait 9:16 stage on desktop; fills the screen on phones. */}
        <div
          ref={refs.stageRef}
          style={theme}
          className="stage relative h-dvh w-[min(100vw,56.25dvh)] overflow-hidden bg-black/40"
        >
          <Board
            boardRef={refs.boardRef}
            layerRef={refs.layerRef}
            fxRef={refs.fxRef}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          />

          {state.status !== 'menu' && (
            <Hud
              title={activeSong.title}
              score={state.score}
              speedMultiplier={state.speedMultiplier}
              progress={state.progress}
            />
          )}

          {state.status === 'menu' && (
            <SongSelect
              songs={SONGS}
              stats={stats}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPlay={start}
            />
          )}

          {state.status === 'gameover' && (
            <GameOverOverlay
              song={activeSong}
              score={state.score}
              best={state.highScore}
              isNewBest={lastRun?.isNewBest ?? false}
              onRestart={() => start(activeSong.id)}
              onMenu={quit}
            />
          )}
        </div>
      </main>
    </div>
  );
}
