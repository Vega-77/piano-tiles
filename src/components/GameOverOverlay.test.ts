import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAME_OVER_REVEAL_MS } from '../config';
import type { GameOverResult } from '../game/engine';
import { mount, type Mounted } from '../hooks/testing';
import type { Song } from '../types';
import { GameOverOverlay, offerText, reasonText } from './GameOverOverlay';

const song = { title: 'Test song', difficulty: 1 } as Song;
const stats = { perfect: 4, good: 1, ok: 0, maxChain: 4, tiles: 5, laps: 0 };
const result = (over: Partial<GameOverResult>): GameOverResult => ({
  score: 400, isNewBest: false, songId: 'test', reason: 'miss', stats, continueScore: null, ...over,
});

let shown: Mounted | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
  vi.useRealTimers();
});

/** The screen as the game shows it once it has been given a moment (before that its buttons can't be pressed by a frantic last tap). */
async function show(over: Partial<GameOverResult>) {
  const calls = { onContinue: 0, onFinish: 0, onRestart: 0, onMenu: 0 };
  shown = await mount(
    createElement(GameOverOverlay, {
      song,
      score: 400,
      best: 900,
      result: result(over),
      onContinue: () => calls.onContinue++,
      onFinish: () => calls.onFinish++,
      onRestart: () => calls.onRestart++,
      onMenu: () => calls.onMenu++,
    }),
  );
  const buttons = () => Array.from(shown!.container.querySelectorAll('button'));
  const press = (text: string) => {
    const button = buttons().find((candidate) => candidate.textContent?.includes(text));
    if (!button) throw new Error(`no button "${text}" among ${buttons().map((b) => b.textContent).join(', ')}`);
    return act(async () => button.click());
  };
  return { calls, buttons, press, text: () => shown!.container.textContent ?? '' };
}

const reveal = () => act(async () => void vi.advanceTimersByTime(GAME_OVER_REVEAL_MS + 50));

describe('the offer to carry on', () => {
  it('shows what would be kept and the two ways to answer, and not the final result yet', async () => {
    const screen = await show({ continueScore: 300 });
    await reveal();
    expect(screen.text()).toContain('Carry on from where you fell?');
    expect(screen.text()).toContain('You keep 300 of your 400 points');
    expect(screen.buttons().map((button) => button.textContent)).toEqual(['Continue with 300', 'No thanks, keep 400']);
    expect(screen.text()).not.toContain('Best');
    expect(screen.text()).not.toContain('Play again');
  });

  it('carries on when taken up, and ends the run when turned down', async () => {
    const screen = await show({ continueScore: 300 });
    await reveal();
    await screen.press('Continue with 300');
    expect(screen.calls).toMatchObject({ onContinue: 1, onFinish: 0 });
    await screen.press('No thanks');
    expect(screen.calls).toMatchObject({ onContinue: 1, onFinish: 1 });
  });

  it('cannot be answered by a frantic last tap: the buttons wait for the reveal', async () => {
    const screen = await show({ continueScore: 300 });
    expect(screen.buttons().every((button) => button.disabled)).toBe(true);
    await reveal();
    expect(screen.buttons().every((button) => !button.disabled)).toBe(true);
  });

  it('gives way to the result once turned down: the run is over, with its own buttons', async () => {
    const screen = await show({ continueScore: null, isNewBest: true });
    await reveal();
    expect(screen.text()).toContain('New best!');
    expect(screen.text()).not.toContain('Carry on');
    expect(screen.buttons().map((button) => button.textContent)).toEqual(['Play again', 'Choose another song']);
    await screen.press('Play again');
    await screen.press('Choose another song');
    expect(screen.calls).toMatchObject({ onRestart: 1, onMenu: 1, onContinue: 0, onFinish: 0 });
  });
});

describe('what the game over screen says ended the run', () => {
  it('says how far off a tap was when it was one that missed', () => {
    expect(reasonText({ reason: 'early', by: 400 })).toBe('You tapped too early: the tile was still 400 ms from the bar');
    expect(reasonText({ reason: 'miss', by: 310 })).toBe('You tapped 310 ms too late');
  });

  it('otherwise just says what happened', () => {
    expect(reasonText({ reason: 'miss' })).toBe('You missed a tile');
    expect(reasonText({ reason: 'early' })).toBe('You tapped too early: the tile was nowhere near the bar');
    expect(reasonText({ reason: 'wrong' })).toBe('You tapped a lane with no tile in it');
  });
});

describe('what the offer to carry on says it costs', () => {
  it('names what is kept, the share that is taken, the chain and that it is only once', () => {
    const text = offerText(400, 300);
    expect(text).toContain('You keep 300 of your 400 points (25% is taken)');
    expect(text).toContain('your chain starts over');
    expect(text).toContain('only be done once per run');
  });
});
