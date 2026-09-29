import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { trace, tracing } from '../game/trace';
import { mount, settle } from '../hooks/testing';
import { InputLog, wantsInputLog } from './InputLog';

const touch = (type: string, pointerId: number, x = 30) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId, clientX: x, clientY: 200 });

describe('the input readout', () => {
  it('is only asked for with ?input on the address', () => {
    expect(wantsInputLog('?input')).toBe(true);
    expect(wantsInputLog('?song=1&input')).toBe(true);
    expect(wantsInputLog('')).toBe(false);
    expect(wantsInputLog('?song=1')).toBe(false);
  });

  it('counts the fingers that are down and says what became of each', async () => {
    const { container, unmount } = await mount(createElement(InputLog));
    const fire = (event: Event) => settle(() => void document.body.dispatchEvent(event));
    expect(container.textContent).toContain('fingers down: 0');

    await fire(touch('pointerdown', 2, 40));
    await fire(touch('pointerdown', 3, 400));
    expect(container.textContent).toContain('fingers down: 2');
    expect(container.textContent).toContain('down touch #3 x400 y200');

    await fire(touch('pointercancel', 2));
    expect(container.textContent).toContain('fingers down: 1');
    expect(container.textContent).toContain('cancel touch #2');

    await fire(touch('pointerup', 3));
    expect(container.textContent).toContain('fingers down: 0');
    await unmount();
  });

  it('keeps only the latest lines', async () => {
    const { container, unmount } = await mount(createElement(InputLog));
    for (let i = 0; i < 20; i++) await settle(() => void document.body.dispatchEvent(touch('pointerup', 100 + i)));
    const lines = container.querySelectorAll('p');
    expect(lines.length).toBe(15); // the count, and fourteen lines
    expect(container.textContent).toContain('#119');
    expect(container.textContent).toContain('#106 ');
    expect(container.textContent).not.toContain('#105 ');
    await unmount();
  });

  it('also shows what the game made of each tap, for as long as it is on the page', async () => {
    const { container, unmount } = await mount(createElement(InputLog));
    expect(tracing()).toBe(true);
    await settle(() => trace(() => 'tap L2: good +120ms'));
    expect(container.textContent).toContain('tap L2: good +120ms');
    await unmount();
    expect(tracing()).toBe(false);
  });
});
