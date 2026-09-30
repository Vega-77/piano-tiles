import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Board } from './components/Board';
import { AccountPanel } from './components/AccountPanel';
import { GameOverOverlay } from './components/GameOverOverlay';
import { Hud } from './components/Hud';
import { ImportPanel } from './components/ImportPanel';
import { InputLog, wantsInputLog } from './components/InputLog';
import { Leaderboard } from './components/Leaderboard';
import { JobStatus } from './components/JobStatus';
import { PauseOverlay } from './components/PauseOverlay';
import { RunStanding } from './components/RunStanding';
import { SongSelect } from './components/SongSelect';
import { TuneScreen } from './components/TuneScreen';
import { useCatalog } from './hooks/useCatalog';
import { useCloud } from './hooks/useCloud';
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
  const cloud = useCloud();
  const catalog = useCatalog({ refresh: library.refresh });
  const importer = useImporter(library.refresh);
  const { admin } = cloud;
  // A draft is the admin's own work: everyone else plays only what has been published.
  const songs = useMemo(() => (admin ? library.songs : library.songs.filter((song) => song.imported?.publication !== 'draft')), [admin, library.songs]);
  const game = useGame(songs, catalog.prepare);
  const { state, lastRun, stats, selectedId, setSelectedId, activeSong, refs, start, quit, pause, resume } = game;
  // (With no song to follow, the stylesheet's own colours apply.)
  const theme = activeSong ? ({ '--hue': activeSong.hue, '--hue2': activeSong.hue2 } as CSSProperties) : undefined;
  useKeepFileDropsOut();
  const [inputLog] = useState(wantsInputLog);

  // The menu is either for picking a song or, when a song has been chosen to tune, for tuning it.
  // (It stays chosen while that song is played, so quitting the game comes back to the tuning.)
  const [tuningId, setTuningId] = useState<string | null>(null);
  const tuning = admin ? songs.find((song) => song.id === tuningId && song.imported) : undefined;

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
              onPublish={importer.publish}
              onUnpublish={importer.unpublish}
              onResetScores={cloud.resetScores}
              onRemove={removeSong}
              onPlay={start}
              onBack={stopTuning}
            />
          )}

          {state.status === 'menu' && !tuning && (
            <SongSelect
              songs={songs}
              ready={library.ready && (songs.length > 0 || !catalog.syncing)}
              stats={stats}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onPlay={start}
              loadingId={game.loadingId}
              loadProgress={game.loadProgress}
              loadError={game.loadError}
              problems={library.problems}
              onDropFile={admin ? addSong : undefined}
              admin={admin}
              empty={<p className="font-bold text-white">{catalog.error ? 'The published songs could not be looked at' : 'No songs have been published yet'}</p>}
              account={<AccountPanel cloud={cloud} />}
              board={(song) =>
                song.imported && song.imported.publication !== 'draft' && !cloud.checking ? (
                  <Leaderboard songId={song.id} load={cloud.loadBoard} uid={cloud.account?.uid} />
                ) : null
              }
              notice={
                catalog.error && (
                  <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl bg-amber-400/10 px-3 py-2 text-xs leading-snug text-amber-200 ring-1 ring-amber-300/30">
                    <p className="min-w-0 flex-1">{catalog.error}</p>
                    <button type="button" onClick={() => void catalog.sync()} className="btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold text-white">
                      Try again
                    </button>
                  </div>
                )
              }
              adder={admin && <ImportPanel busy={working !== null} persistent={library.persistent} onFile={addSong} />}
              status={jobStatus(admin ? tune : undefined)}
              onTune={admin ? (song) => tune(song.id) : undefined}
            />
          )}

          {state.status === 'playing' && state.paused && <PauseOverlay onResume={resume} onQuit={quit} />}

          {state.status === 'gameover' && activeSong && (
            <GameOverOverlay
              song={activeSong}
              score={state.score}
              best={state.highScore}
              result={lastRun}
              standing={
                // (Only a song as it is published counts: a draft, or one changed since, is not the chart everyone plays. And a
                // run that can still be continued is not over: what it scores is not known yet.)
                lastRun && lastRun.continueScore === null && lastRun.score > 0 && activeSong.imported?.publication === 'live' ? (
                  <RunStanding
                    songId={activeSong.id}
                    run={{ score: lastRun.score, laps: lastRun.stats.laps, chain: lastRun.stats.maxChain }}
                    cloud={cloud}
                  />
                ) : null
              }
              onContinue={game.continueRun}
              onFinish={game.finish}
              onRestart={() => start(activeSong.id)}
              onMenu={quit}
            />
          )}
        </div>
      </main>
      {inputLog && <InputLog />}
    </div>
  );
}
