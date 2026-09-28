import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { LANES } from '../config';
import { AudioEngine } from '../game/audio';
import { GameEngine, createInitialState, type GameOverResult } from '../game/engine';
import { loadHighScore } from '../game/storage';
import type { GameState } from '../types';

const LANE_KEYS: Record<string, number> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

/** Bridges the imperative engine to React: state updates only on discrete game events. */
export function useGame() {
  const boardRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);

  const [state, setState] = useState<GameState>(() => createInitialState(loadHighScore()));
  const [lastRun, setLastRun] = useState<GameOverResult | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    const engine = new GameEngine({
      layer,
      audio: new AudioEngine(),
      onStateChange: setState,
      onGameOver: setLastRun,
    });
    engineRef.current = engine;

    const onKeyDown = (e: KeyboardEvent) => {
      const lane = LANE_KEYS[e.code];
      if (lane !== undefined && !e.repeat) engine.tap(lane);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    setLastRun(null);
    engineRef.current?.start();
  }, []);

  const handlePointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const board = boardRef.current;
    if (!board || e.button !== 0) return;
    const rect = board.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor(x * LANES)));
    engineRef.current?.tap(lane, y);
  }, []);

  return { state, lastRun, boardRef, layerRef, start, handlePointerDown };
}
