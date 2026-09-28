import { Board } from './components/Board';
import { Hud } from './components/Hud';
import { GameOverOverlay, MenuOverlay } from './components/Overlays';
import { useGame } from './hooks/useGame';

export default function App() {
  const { state, lastRun, boardRef, layerRef, start, handlePointerDown } = useGame();

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-zinc-950">
      {/* Portrait 9:16 stage on desktop; fills the screen on phones. */}
      <div className="relative h-dvh w-[min(100vw,56.25dvh)] overflow-hidden bg-white">
        <Board boardRef={boardRef} layerRef={layerRef} onPointerDown={handlePointerDown} />

        {state.status !== 'menu' && (
          <Hud score={state.score} speedMultiplier={state.speedMultiplier} />
        )}
        {state.status === 'menu' && <MenuOverlay highScore={state.highScore} onStart={start} />}
        {state.status === 'gameover' && (
          <GameOverOverlay
            score={state.score}
            highScore={state.highScore}
            isNewBest={lastRun?.isNewBest ?? false}
            onRestart={start}
          />
        )}
      </div>
    </main>
  );
}
