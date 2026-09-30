import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVES } from '../config';
import { mount, type Mounted } from '../hooks/testing';
import { Hud } from './Hud';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

async function show(lives: number) {
  shown = await mount(
    createElement(Hud, {
      title: 'A song',
      score: 1200,
      combo: 7,
      comboMultiplier: 2,
      lives,
      lap: 0,
      speedMultiplier: 1,
      progress: 0.4,
      onPause: () => {},
    }),
  );
  return shown.container;
}

const hearts = (container: HTMLElement) => container.querySelector('[role="img"]')!;
/** The hearts that are still filled in, as against the outlines of the ones that were lost. */
const kept = (container: HTMLElement) => hearts(container).querySelectorAll('path.fill-rose-400').length;

describe('the hearts', () => {
  it('show every life the run starts with, and say so for a screen reader', async () => {
    const container = await show(LIVES);
    expect(hearts(container).querySelectorAll('svg')).toHaveLength(LIVES);
    expect(kept(container)).toBe(LIVES);
    expect(hearts(container).getAttribute('aria-label')).toBe(`${LIVES} of ${LIVES} lives left`);
  });

  it('leave an outline where a life was lost', async () => {
    const container = await show(1);
    expect(hearts(container).querySelectorAll('svg')).toHaveLength(LIVES);
    expect(kept(container)).toBe(1);
    expect(hearts(container).getAttribute('aria-label')).toBe(`1 of ${LIVES} lives left`);
  });

  it('flash only once a life has been lost', async () => {
    expect(hearts(await show(LIVES)).classList.contains('flash')).toBe(false);
    await shown?.unmount();
    expect(hearts(await show(LIVES - 1)).classList.contains('flash')).toBe(true);
  });
});
