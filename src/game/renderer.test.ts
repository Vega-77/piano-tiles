import { beforeEach, describe, expect, it } from 'vitest';
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
