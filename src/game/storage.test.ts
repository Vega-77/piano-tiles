import { beforeEach, describe, expect, it } from 'vitest';
import { getBest, loadStats, recordRun } from './storage';

beforeEach(() => localStorage.clear());

const run = (score: number, maxChain = 0, laps = 0) => ({ score, maxChain, laps });

describe('song stats', () => {
  it('starts empty', () => {
    expect(loadStats()).toEqual({});
    expect(getBest('ode-to-joy')).toBe(0);
  });

  it('records plays and only raises the best', () => {
    expect(recordRun('a', run(1000))).toEqual({
      stats: { best: 1000, plays: 1, bestChain: 0, bestLaps: 0 },
      isNewBest: true,
    });
    expect(recordRun('a', run(400)).stats).toMatchObject({ best: 1000, plays: 2 });
    expect(recordRun('a', run(1000)).isNewBest).toBe(false); // a tie isn't a new best
    expect(recordRun('a', run(2500)).stats).toMatchObject({ best: 2500, plays: 4 });
    expect(getBest('a')).toBe(2500);
    expect(getBest('b')).toBe(0);
  });

  it('keeps the best chain and most laps separately from the best score', () => {
    recordRun('a', run(5000, 20, 2));
    const { stats } = recordRun('a', run(100, 35, 0));
    expect(stats).toMatchObject({ best: 5000, bestChain: 35, bestLaps: 2 });
  });

  it('does not count a zero score as a new best', () => {
    expect(recordRun('a', run(0)).isNewBest).toBe(false);
  });

  it('ignores records from the old tile-count scoring', () => {
    localStorage.setItem('piano-tiles:songs:v1', JSON.stringify({ 'ode-to-joy': { best: 101, plays: 3 } }));
    localStorage.setItem('piano-tiles:high-score', '101');
    expect(getBest('ode-to-joy')).toBe(0);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('piano-tiles:songs:v2', '{not json');
    expect(loadStats()).toEqual({});
  });
});
