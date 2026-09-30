import { LANES, TILE_HEIGHT } from '../config';
import type { Tile } from '../types';

interface TileElements {
  root: HTMLDivElement;
  fill: HTMLDivElement | null;
}

export interface AddOptions {
  /** Hint text on a tap tile (the first tile says "Tap"). */
  label?: string;
  /** Draw a glowing bar from this tile to its partner this many lanes over (doubles); 0 for none. */
  link?: number;
}

/** How long a red cell shows where a finger came down wrongly, in a run that carries on. */
const BRIEF_ERROR_MS = 450;

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/**
 * Owns the tile DOM nodes. Positions are written straight to `transform`, so the 60fps loop
 * never goes through React. Looks are all CSS, switched by `data-kind`, `data-state` and
 * `data-target` on each tile (see index.css).
 */
export class TileRenderer {
  private readonly layer: HTMLElement;
  private readonly elements = new Map<string, TileElements>();

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  add(tile: Tile, { label = '', link = 0 }: AddOptions = {}): void {
    const root = div('tile');
    root.dataset.kind = tile.kind;
    root.dataset.state = 'idle';
    root.dataset.target = 'false';
    root.style.left = `${tile.lane * (100 / LANES)}%`;
    root.style.height = `${tile.rows * TILE_HEIGHT}%`;
    root.style.setProperty('--rows', String(tile.rows));

    if (link > 0) {
      root.style.setProperty('--span', String(link));
      root.append(div('tile-link'));
    }

    const face = div('tile-face');
    face.append(div('tile-shine'));

    let fill: HTMLDivElement | null = null;
    if (tile.kind === 'hold') {
      face.append(div('tile-rows'));
      fill = div('tile-fill');
      face.append(fill);
      const head = div('tile-head');
      head.textContent = 'Hold';
      face.append(head);
    } else if (label) {
      const text = document.createElement('span');
      text.className = 'tile-label';
      text.textContent = label;
      face.append(text);
    }

    root.append(face);
    this.place(root, tile);
    this.layer.append(root);
    this.elements.set(tile.id, { root, fill });
  }

  draw(tile: Tile): void {
    const el = this.elements.get(tile.id);
    if (el) this.place(el.root, tile);
  }

  /** Highlight the tiles the player should tap next. */
  setTarget(id: string, isTarget: boolean): void {
    const root = this.elements.get(id)?.root;
    const value = String(isTarget);
    if (root && root.dataset.target !== value) root.dataset.target = value;
  }

  markHit(id: string): void {
    this.setState(id, 'hit');
    this.elements.get(id)?.root.querySelector('.tile-label')?.remove();
  }

  markHolding(id: string): void {
    this.setState(id, 'holding');
  }

  /** 0–1: how much of a held tile has flowed past the finger. */
  setHoldProgress(id: string, progress: number): void {
    const fill = this.elements.get(id)?.fill;
    if (fill) fill.style.transform = `scaleY(${Math.max(0, Math.min(1, progress))})`;
  }

  markDone(id: string): void {
    this.setHoldProgress(id, 1);
    this.setState(id, 'done');
  }

  /** A hold tile the player let go of before its end: it keeps the fill it earned but fades out. */
  markReleased(id: string): void {
    this.setState(id, 'released');
  }

  markMiss(id: string): void {
    this.setState(id, 'miss');
  }

  /**
   * Red cell where the player tapped a blank space or a tile out of order. It stays for good when that ended the run;
   * otherwise (`brief`) it flashes and goes, as the board carries on.
   */
  showError(lane: number, yPos: number, brief = false): void {
    const root = div('tile tile-error');
    root.style.left = `${lane * (100 / LANES)}%`;
    root.style.height = `${TILE_HEIGHT}%`;
    root.style.transform = `translate3d(0, ${(yPos / TILE_HEIGHT) * 100}%, 0)`;
    const face = div('tile-face');
    face.textContent = '✕';
    root.append(face);
    this.layer.append(root);
    if (brief) window.setTimeout(() => root.remove(), BRIEF_ERROR_MS);
  }

  /** Animate the next draw() instead of snapping (used to reveal a missed tile). */
  enableSettling(): void {
    for (const { root } of this.elements.values()) root.classList.add('settle');
  }

  remove(id: string): void {
    this.elements.get(id)?.root.remove();
    this.elements.delete(id);
  }

  clear(): void {
    this.layer.replaceChildren();
    this.elements.clear();
  }

  private setState(id: string, state: string): void {
    const root = this.elements.get(id)?.root;
    if (root) root.dataset.state = state;
  }

  private place(root: HTMLElement, tile: Tile): void {
    // translateY percentages are relative to the tile's own height (rows * 25% of the board).
    root.style.transform = `translate3d(0, ${(tile.yPos / (tile.rows * TILE_HEIGHT)) * 100}%, 0)`;
  }
}
