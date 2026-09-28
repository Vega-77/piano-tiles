import { LANES, TILE_HEIGHT } from '../config';
import type { Tile } from '../types';

const TILE_CLASS =
  'absolute top-0 flex h-1/4 w-1/4 items-center justify-center border border-white/30 bg-zinc-950 text-lg font-bold uppercase tracking-[0.3em] text-white will-change-transform';
const HIT_BG = 'bg-zinc-300';
const MISS_BG = 'bg-red-500';
const IDLE_BG = 'bg-zinc-950';
const SETTLE_CLASSES = ['transition-transform', 'duration-200', 'ease-out'];

/**
 * Owns the tile DOM nodes. Positions are written straight to `transform`, so the
 * 60fps loop never goes through React. Tile elements are 25% of the layer's height,
 * so translateY(N%) is relative to a tile: yPos% of the board == yPos / 25 * 100%.
 */
export class TileRenderer {
  private readonly layer: HTMLElement;
  private readonly elements = new Map<string, HTMLDivElement>();

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  add(tile: Tile, label = ''): void {
    const el = document.createElement('div');
    el.className = TILE_CLASS;
    el.style.left = `${tile.lane * (100 / LANES)}%`;
    el.textContent = label;
    place(el, tile.yPos);
    this.layer.appendChild(el);
    this.elements.set(tile.id, el);
  }

  draw(tile: Tile): void {
    const el = this.elements.get(tile.id);
    if (el) place(el, tile.yPos);
  }

  markHit(id: string): void {
    const el = this.elements.get(id);
    if (!el) return;
    el.classList.replace(IDLE_BG, HIT_BG);
    el.textContent = '';
  }

  markMiss(id: string): void {
    this.elements.get(id)?.classList.replace(IDLE_BG, MISS_BG);
  }

  /** Red cell where the player tapped a blank space or the wrong tile. */
  showError(lane: number, yPos: number): void {
    const el = document.createElement('div');
    el.className = `${TILE_CLASS.replace(IDLE_BG, MISS_BG)} text-3xl tracking-normal`;
    el.style.left = `${lane * (100 / LANES)}%`;
    el.textContent = '✕';
    place(el, yPos);
    this.layer.appendChild(el);
  }

  /** Animate the next draw() instead of snapping (used to reveal a missed tile). */
  enableSettling(): void {
    for (const el of this.elements.values()) el.classList.add(...SETTLE_CLASSES);
  }

  remove(id: string): void {
    this.elements.get(id)?.remove();
    this.elements.delete(id);
  }

  clear(): void {
    this.layer.replaceChildren();
    this.elements.clear();
  }
}

function place(el: HTMLElement, yPos: number): void {
  el.style.transform = `translate3d(0, ${(yPos / TILE_HEIGHT) * 100}%, 0)`;
}
