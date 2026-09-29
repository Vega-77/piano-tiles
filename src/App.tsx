import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Board } from './components/Board';
import { GameOverOverlay } from './components/GameOverOverlay';
import { Hud } from './components/Hud';
import { ImportPanel } from './components/ImportPanel';
import { JobStatus } from './components/JobStatus';
import { PauseOverlay } from './components/PauseOverlay';
import { SongSelect } from './components/SongSelect';
import { TuneScreen } from './components/TuneScreen';
import { useGame } from './hooks/useGame';
import { useImporter } from './hooks/useImporter';
import { useLibrary } from './hooks/useLibrary';

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
  // (With no song to follow, the stylesheet's own colours apply.)
  const theme = activeSong ? ({ '--hue': activeSong.hue, '--hue2': activeSong.hue2 } as CSSProperties) : undefined;
  useKeepFileDropsOut();

  // The menu is either for picking a song or, when a song has been chosen to tune, for tuning it.
  // (It stays chosen while that song is played, so quitting the game comes back to the tuning.)
  const [tuningId, setTuningId] = useState<string | null>(null);
  const tuning = library.songs.find((song) => song.id === tuningId && song.imported);

  const { add, remove, dismiss, working } = importer;
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
      // (The removed song stops being selectable once the library is read again.)
      if (await remove(id)) setTuningId(null);
    },
    [remove],
  );
  const tune = useCallback(
    (id: string) => {
      dismiss();
      setSelectedId(id);
      setTuningId(id);
    },
    [dismiss, setSelectedId],
  );
  const stopTuning = useCallback(() => setTuningId(null), []);

  const jobStatus = (onTune?: (id: string) => void) => (
    <JobStatus
      working={working}
      error={importer.error}
      added={importer.added}
      persistent={library.persistent}
      onCancel={importer.cancel}
      onDismiss={dismiss}
      onTune={onTune}
    />
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-zinc-950">
      {/* Full-window animated backdrop, drawn by the effects layer. */}
      <canvas ref={refs.bgRef} className="absolute inset-0 h-full w-full" aria-hidden />

      <main className="relative flex h-dvh w-full items-center justify-center">
        {/* A 4:5 stage on desktop (never wider than a comfortable reading width); fills the screen on phones. */}
        <div
          ref={refs.stageRef}
          style={theme}
          className="stage relative h-dvh w-[min(100vw,80dvh,56rem)] overflow-hidden bg-black/40"
        >
          <Board
            boardRef={refs.boardRef}
            layerRef={refs.layerRef}
            fxRef={refs.fxRef}
            onPointerDown={game.handlePointerDown}
            onPointerUp={game.handlePointerUp}
          />

          {state.status !== 'menu' && activeSong && (
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

          {state.status === 'menu' && tuning && (
            <TuneScreen
              key={tuning.id}
              song={tuning}
              busy={working !== null}
              status={jobStatus()}
              onTune={importer.tune}
              onRechart={importer.rechart}
              onSave={importer.save}
              onRemove={removeSong}
              onPlay={start}
              onBack={stopTuning}
            />
          )}

          {state.status === 'menu' && !tuning && (
            <SongSelect
              songs={library.songs}
              ready={library.ready}
              stats={stats}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPlay={start}
              loadingId={game.loadingId}
              loadError={game.loadError}
              problems={library.problems}
              onDropFile={addSong}
              adder={<ImportPanel busy={working !== null} persistent={library.persistent} onFile={addSong} />}
              status={jobStatus(tune)}
              onTune={(song) => tune(song.id)}
            />
          )}

          {state.status === 'playing' && state.paused && <PauseOverlay onResume={resume} onQuit={quit} />}

          {state.status === 'gameover' && activeSong && (
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
