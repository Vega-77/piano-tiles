import { describe, expect, it } from 'vitest';
import { LAP_SPEED_FACTOR } from '../config';
import { Timeline } from './timeline';

// 2 rows/s, 10 rows per lap, first tile reaches the bar at t = 5.
const make = () => new Timeline(2, 10, 5);

describe('Timeline', () => {
  it('scrolls at the base rate on the first lap, including the lead-in', () => {
    const timeline = make();
    expect(timeline.rowsAt(5)).toBe(0);
    expect(timeline.rowsAt(6)).toBeCloseTo(2, 9);
    expect(timeline.rowsAt(3)).toBeCloseTo(-4, 9); // before the song starts
    expect(timeline.rate(0)).toBe(2);
  });

  it('jumps the speed by a fixed factor every lap', () => {
    const timeline = make();
    expect(timeline.speedFactor(0)).toBe(1);
    expect(timeline.speedFactor(1)).toBeCloseTo(LAP_SPEED_FACTOR, 9);
    expect(timeline.speedFactor(2)).toBeCloseTo(LAP_SPEED_FACTOR ** 2, 9);
    expect(timeline.rate(3) / timeline.rate(2)).toBeCloseTo(LAP_SPEED_FACTOR, 9);
  });

  it('gets shorter laps as it speeds up', () => {
    const timeline = make();
    const lap0 = timeline.lapStart(1) - timeline.lapStart(0);
    const lap1 = timeline.lapStart(2) - timeline.lapStart(1);
    expect(lap0).toBeCloseTo(5, 9); // 10 rows at 2 rows/s
    expect(lap1).toBeCloseTo(5 / LAP_SPEED_FACTOR, 9);
  });

  it('finds the lap for a time', () => {
    const timeline = make();
    expect(timeline.lapAt(0)).toBe(0);
    expect(timeline.lapAt(9.99)).toBe(0);
    expect(timeline.lapAt(timeline.lapStart(1))).toBe(1);
    expect(timeline.lapAt(timeline.lapStart(3) + 0.001)).toBe(3);
  });

  it('is continuous across lap boundaries', () => {
    const timeline = make();
    const boundary = timeline.lapStart(1);
    expect(timeline.rowsAt(boundary)).toBeCloseTo(10, 9);
    expect(timeline.rowsAt(boundary - 1e-6)).toBeCloseTo(10, 4);
    expect(timeline.rowsAt(boundary + 1)).toBeCloseTo(10 + LAP_SPEED_FACTOR * 2, 9);
  });

  it('places arrivals so that scroll position equals the row when a tile arrives', () => {
    const timeline = make();
    for (const [lap, row] of [[0, 0], [0, 3], [0, 9], [1, 0], [1, 4], [2, 7]] as const) {
      const at = timeline.arrival(lap, row);
      expect(timeline.rowsAt(at)).toBeCloseTo(lap * 10 + row, 9);
    }
    // The same row arrives sooner after it than before, because the song is faster.
    const gap0 = timeline.arrival(0, 5) - timeline.arrival(0, 4);
    const gap2 = timeline.arrival(2, 5) - timeline.arrival(2, 4);
    expect(gap0 / gap2).toBeCloseTo(LAP_SPEED_FACTOR ** 2, 9);
  });
});
