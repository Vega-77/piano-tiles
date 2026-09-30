import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TileRenderer } from './renderer';
import type { Tile } from '../types';

const tile = (overrides: Partial<Tile> = {}): Tile => ({
  id: 't1',
  lane: 0,
  yPos: 0,
  isHit: false,
  kind: 'tap',
  rows: 1,
  beat: 0,
  freq: 440,
  start: 0,
  time: 1,
  lateWindow: 0.25,
  hold: null,
  ...overrides,
});

let layer: HTMLElement;
let renderer: TileRenderer;
beforeEach(() => {
  layer = document.createElement('div');
  renderer = new TileRenderer(layer);
});
afterEach(() => vi.useRealTimers());

describe('the tiles of a double', () => {
  it('draw a bar as many lanes wide as the two tiles are apart', () => {
    renderer.add(tile({ lane: 0 }), { link: 3 });
    const root = layer.querySelector<HTMLElement>('.tile')!;
    expect(root.style.getPropertyValue('--span')).toBe('3');
    expect(root.querySelectorAll('.tile-link')).toHaveLength(1);
  });

  it('draw no bar for a tile that stands alone', () => {
    renderer.add(tile());
    expect(layer.querySelector('.tile-link')).toBeNull();
  });
});

describe('the red cell for a wrong tap', () => {
  it('stays when it ended the run', () => {
    vi.useFakeTimers();
    renderer.showError(2, 0.5);
    vi.advanceTimersByTime(10_000);
    expect(layer.querySelectorAll('.tile-error')).toHaveLength(1);
  });

  it('goes again after a moment when the run carries on', () => {
    vi.useFakeTimers();
    renderer.showError(2, 0.5, true);
    expect(layer.querySelectorAll('.tile-error')).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(layer.querySelectorAll('.tile-error')).toHaveLength(0);
  });
});
