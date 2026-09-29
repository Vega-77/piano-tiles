import { createElement, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mount, settle } from '../hooks/testing';
import { Board } from './Board';

const touch = (type: string, pointerId: number) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId, clientX: 10, clientY: 10 });

async function setup() {
  const onPointerDown = vi.fn();
  const onPointerUp = vi.fn();
  const boardRef = createRef<HTMLDivElement>();
  const mounted = await mount(
    createElement(Board, {
      boardRef,
      layerRef: createRef<HTMLDivElement>(),
      fxRef: createRef<HTMLCanvasElement>(),
      onPointerDown,
      onPointerUp,
    }),
  );
  const fire = (event: Event) => settle(() => void boardRef.current!.dispatchEvent(event));
  return { board: boardRef.current!, onPointerDown, onPointerUp, fire, mounted };
}

const idsOf = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([e]) => (e as PointerEvent).pointerId);

describe('the board', () => {
  it('hears every finger that lands on it, one after the other', async () => {
    const { fire, onPointerDown, mounted } = await setup();
    await fire(touch('pointerdown', 2));
    await fire(touch('pointerdown', 3));
    expect(idsOf(onPointerDown)).toEqual([2, 3]);
    await mounted.unmount();
  });

  it('hears a finger lift, but not the browser taking one away', async () => {
    const { fire, onPointerUp, mounted } = await setup();
    await fire(touch('pointerup', 2));
    await fire(touch('pointercancel', 3));
    expect(idsOf(onPointerUp)).toEqual([2]);
    await mounted.unmount();
  });

  it("doesn't let the browser start a gesture on a touch", async () => {
    const { board, mounted } = await setup();
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    board.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    await mounted.unmount();
    // (Nothing is left listening once the board is gone.)
    const later = new Event('touchstart', { bubbles: true, cancelable: true });
    board.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });
});
