import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { trace, tracing } from '../game/trace';
import { mount, settle } from '../hooks/testing';
import { heardLate, InputLog, wantsInputLog } from './InputLog';

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
    for (let i = 0; i < 30; i++) await settle(() => void document.body.dispatchEvent(touch('pointerup', 100 + i)));
    const lines = container.querySelectorAll('p');
    expect(lines.length).toBe(21); // the count, and twenty lines
    expect(container.textContent).toContain('#129');
    expect(container.textContent).toContain('#110 ');
    expect(container.textContent).not.toContain('#109 ');
    await unmount();
  });

  it('says how late the page heard of a finger, when it did', async () => {
    expect(heardLate({ timeStamp: 900 }, 1000)).toBe(' (heard 100ms late)');
    expect(heardLate({ timeStamp: 990 }, 1000)).toBe(''); // (an ordinary frame's wait)
    expect(heardLate({ timeStamp: 1010 }, 1000)).toBe('');
    expect(heardLate({ timeStamp: Date.now() }, 1000)).toBe(''); // (some browsers stamp with the epoch)

    const { container, unmount } = await mount(createElement(InputLog));
    const late = touch('pointerdown', 7);
    Object.defineProperty(late, 'timeStamp', { value: performance.now() - 480 });
    await settle(() => void document.body.dispatchEvent(late));
    expect(container.textContent).toMatch(/down \(heard \d{3}ms late\) touch #7/);
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
