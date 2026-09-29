import { useCallback, useEffect, type CSSProperties } from 'react';
import { Board } from './components/Board';
import { GameOverOverlay } from './components/GameOverOverlay';
import { Hud } from './components/Hud';
import { ImportPanel } from './components/ImportPanel';
import { JobStatus } from './components/JobStatus';
import { PauseOverlay } from './components/PauseOverlay';
import { SongSelect } from './components/SongSelect';
import { TunePanel } from './components/TunePanel';
import { useGame } from './hooks/useGame';
import { useImporter } from './hooks/useImporter';
import { useLibrary } from './hooks/useLibrary';
import type { Song } from './types';

/** A file dropped anywhere the menu isn't would otherwise replace the game with the file. */
function useKeepFileDropsOut() {
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const refuse = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener('dragover', refuse);
    window.addEventListener('drop', refuse);
    return () => {
      window.removeEventListener('dragover', refuse);
      window.removeEventListener('drop', refuse);
    };
  }, []);
}

export default function App() {
  const library = useLibrary();
  const game = useGame(library.songs);
  const importer = useImporter(library.refresh);
  const { state, lastRun, stats, selectedId, setSelectedId, activeSong, refs, start, quit, pause, resume } = game;
  const theme = { '--hue': activeSong.hue, '--hue2': activeSong.hue2 } as CSSProperties;
  useKeepFileDropsOut();

  const { add, remove, working } = importer;
  const addSong = useCallback(
    async (file: File) => {
      if (working) return;
      const chart = await add(file);
      if (chart) setSelectedId(chart.id);
    },
    [add, working, setSelectedId],
  );
  const removeSong = useCallback(
    async (id: string) => {
      if (await remove(id)) setSelectedId(library.songs[0].id);
    },
    [remove, library.songs, setSelectedId],
  );

  const tuner = (song: Song) =>
    song.imported ? (
      <TunePanel
        key={song.id}
        song={song}
        busy={working !== null}
        onTune={importer.tune}
        onRechart={importer.rechart}
        onSave={importer.save}
        onRemove={removeSong}
      />
    ) : null;

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
            onPointerDown={game.handlePointerDown}
            onPointerUp={game.handlePointerUp}
          />

          {state.status !== 'menu' && (
            <Hud
              title={activeSong.title}
              score={state.score}
              combo={state.combo}
              comboMultiplier={state.comboMultiplier}
              lap={state.lap}
              speedMultiplier={state.speedMultiplier}
              progress={state.progress}
              onPause={pause}
            />
          )}

          {state.status === 'menu' && (
            <SongSelect
              songs={library.songs}
              stats={stats}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPlay={start}
              loadingId={game.loadingId}
              loadError={game.loadError}
              problems={library.problems}
              onDropFile={addSong}
              adder={
                <ImportPanel
                  busy={working !== null}
                  persistent={library.persistent}
                  choices={importer.choices}
                  onChoices={importer.setChoices}
                  onFile={addSong}
                />
              }
              status={
                <JobStatus
                  working={working}
                  error={importer.error}
                  added={importer.added}
                  persistent={library.persistent}
                  onCancel={importer.cancel}
                  onDismiss={importer.dismiss}
                />
              }
              tuner={tuner}
            />
          )}

          {state.status === 'playing' && state.paused && <PauseOverlay onResume={resume} onQuit={quit} />}

          {state.status === 'gameover' && (
            <GameOverOverlay
              song={activeSong}
              score={state.score}
              best={state.highScore}
              result={lastRun}
              onRestart={() => start(activeSong.id)}
              onMenu={quit}
            />
          )}
        </div>
      </main>
    </div>
  );
}
