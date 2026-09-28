import { beforeEach, describe, expect, it } from 'vitest';
import { getBest, loadStats, recordRun } from './storage';

beforeEach(() => localStorage.clear());

describe('song stats', () => {
  it('starts empty', () => {
    expect(loadStats()).toEqual({});
    expect(getBest('ode-to-joy')).toBe(0);
  });

  it('records plays and only raises the best', () => {
    expect(recordRun('a', 10)).toEqual({ stats: { best: 10, plays: 1 }, isNewBest: true });
    expect(recordRun('a', 4)).toEqual({ stats: { best: 10, plays: 2 }, isNewBest: false });
    expect(recordRun('a', 10).isNewBest).toBe(false); // a tie isn't a new best
    expect(recordRun('a', 25).stats).toEqual({ best: 25, plays: 4 });
    expect(getBest('a')).toBe(25);
    expect(getBest('b')).toBe(0);
  });

  it('does not count a zero score as a new best', () => {
    expect(recordRun('a', 0).isNewBest).toBe(false);
  });

  it('migrates the old single high score to Ode to Joy', () => {
    localStorage.setItem('piano-tiles:high-score', '101');
    expect(getBest('ode-to-joy')).toBe(101);
    expect(getBest('twinkle')).toBe(0);
    recordRun('twinkle', 5);
    expect(getBest('ode-to-joy')).toBe(101); // survives being saved into the new format
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('piano-tiles:songs:v1', '{not json');
    expect(loadStats()).toEqual({});
  });
});
