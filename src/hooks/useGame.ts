import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { LANES } from '../config';
import { AudioEngine } from '../game/audio';
import { Effects } from '../game/effects';
import { createInitialState, GameEngine, type GameOverResult } from '../game/engine';
import { loadStats, type StatsMap } from '../game/storage';
import { readStoredAudio } from '../songs/store';
import type { GameState, Song } from '../types';

const LANE_KEYS: Record<string, number> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

/** Bridges the imperative engine and effects to React: state updates only on discrete game events. */
export function useGame(songs: readonly Song[]) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const effectsRef = useRef<Effects | null>(null);
  const songsRef = useRef(songs);
  /** The song being fetched before it can start (a recording has to be downloaded and decoded first). */
  const loadingRef = useRef<string | null>(null);

  const [state, setState] = useState<GameState>(createInitialState);
  const [lastRun, setLastRun] = useState<GameOverResult | null>(null);
  const [stats, setStats] = useState<StatsMap>(loadStats);
  const [pickedId, setSelectedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    songsRef.current = songs;
  }, [songs]);

  // The song highlighted in the menu. A song that isn't there (not read yet, or just removed) can't
  // be highlighted: the first song stands in, and there is none while the library is empty.
  const selectedId = songs.some((song) => song.id === pickedId) ? pickedId : (songs[0]?.id ?? null);

  // What the theme colours follow: the song being played, or the one highlighted in the menu.
  const wanted = state.status === 'menu' ? selectedId : state.songId;
  const activeSong: Song | undefined = songs.find((song) => song.id === wanted);

  useEffect(() => {
    const bg = bgRef.current;
    const fx = fxRef.current;
    const layer = layerRef.current;
    if (!bg || !fx || !layer) return;

    const effects = new Effects(bg, fx, stageRef.current);
    effects.start();
    const audio = new AudioEngine({ read: readStoredAudio });
    const engine = new GameEngine({
      layer,
      audio,
      effects,
      onStateChange: setState,
      onGameOver: (result) => {
        setLastRun(result);
        setStats(loadStats());
      },
    });
    engineRef.current = engine;
    audioRef.current = audio;
    effectsRef.current = effects;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Escape') {
        const { status, paused } = engine.getState();
        if (status === 'playing') {
          if (paused) engine.resume();
          else engine.pause();
        } else if (status === 'gameover') {
          setLastRun(null);
          engine.quit();
        }
        return;
      }
      const lane = LANE_KEYS[e.code];
      if (lane !== undefined) engine.press(lane, `k:${e.code}`);
    };
    const onKeyUp = (e: KeyboardEvent) => engine.release(`k:${e.code}`);
    // The song runs on the audio clock, so freeze it when the player leaves the tab.
    const onVisibility = () => {
      if (document.hidden) engine.pause();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', onVisibility);
      engine.destroy();
      effects.destroy();
      engineRef.current = null;
      audioRef.current = null;
      effectsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activeSong) effectsRef.current?.setTheme(activeSong.hue, activeSong.hue2);
  }, [activeSong]);

  const start = useCallback(async (songId: string) => {
    const song = songsRef.current.find((candidate) => candidate.id === songId);
    const engine = engineRef.current;
    const audio = audioRef.current;
    if (!song || !engine || !audio || loadingRef.current) return;
    setSelectedId(songId);
    setLastRun(null);
    setLoadError(null);

    if (song.recording) {
      // A recording has to be downloaded and decoded before it can start on time. The audio
      // context is unlocked first, while the click that asked to play is still going on: browsers
      // only allow that in a gesture, and the wait for the download would be too late.
      audio.unlock();
      loadingRef.current = songId;
      setLoadingId(songId);
      try {
        await audio.load(song.recording.url);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Couldn't load the song's audio.");
        return;
      } finally {
        loadingRef.current = null;
        setLoadingId(null);
      }
      if (!engineRef.current) return; // (the page was closed while it loaded)
    }
    engine.start(song);
  }, []);

  const quit = useCallback(() => {
    setLastRun(null);
    engineRef.current?.quit();
  }, []);

  const pause = useCallback(() => engineRef.current?.pause(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Keep receiving this finger's events even if it slides off the board, so a held tile can be released.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not fatal: some browsers refuse capture for synthetic events.
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor(x * LANES)));
    engineRef.current?.press(lane, `p${e.pointerId}`);
  }, []);

  const handlePointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    engineRef.current?.release(`p${e.pointerId}`);
  }, []);

  return {
    state,
    lastRun,
    stats,
    selectedId,
    setSelectedId,
    activeSong,
    loadingId,
    loadError,
    refs: { bgRef, fxRef, stageRef, boardRef, layerRef },
    start,
    quit,
    pause,
    resume,
    handlePointerDown,
    handlePointerUp,
  };
}
