import { describe, expect, it } from 'vitest';
import { reasonText } from './GameOverOverlay';

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
