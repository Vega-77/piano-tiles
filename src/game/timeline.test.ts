import { describe, expect, it } from 'vitest';
import { LAP_REST_SECONDS, LAP_SPEED_FACTOR } from '../config';
import { Timeline } from './timeline';

// 2 rows/s, 10 rows per lap, first tile reaches the bar at t = 5, 8 rows of count-in before later laps.
const COUNT_IN = 8;
const make = () => new Timeline(2, 10, 5, COUNT_IN);

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

  it('leaves a rest and a count-in of empty rows in front of every lap but the first', () => {
    const timeline = make();
    expect(timeline.gapRows(0)).toBe(0);
    for (const lap of [1, 2, 5]) {
      const rest = timeline.gapRows(lap) - COUNT_IN;
      // At least the rest time at that lap's speed, and never a whole extra row of it.
      expect(rest / timeline.rate(lap)).toBeGreaterThanOrEqual(LAP_REST_SECONDS);
      expect((rest - 1) / timeline.rate(lap)).toBeLessThan(LAP_REST_SECONDS);
    }
  });

  it('spends the same number of rows on each lap, plus the gap in front of it', () => {
    const timeline = make();
    expect(timeline.origin(0)).toBe(0);
    expect(timeline.origin(1)).toBe(10 + timeline.gapRows(1));
    expect(timeline.origin(2)).toBe(timeline.origin(1) + 10 + timeline.gapRows(2));
  });

  it('starts each lap after the last one has ended and its gap has scrolled by, at the new speed', () => {
    const timeline = make();
    expect(timeline.lapEnd(0)).toBeCloseTo(5 + 10 / 2, 9); // 10 rows at 2 rows/s
    for (const lap of [1, 2, 3]) {
      const gap = timeline.lapStart(lap) - timeline.lapEnd(lap - 1);
      expect(gap).toBeCloseTo(timeline.gapRows(lap) / timeline.rate(lap), 9);
      expect(gap).toBeGreaterThan(LAP_REST_SECONDS);
    }
    const body0 = timeline.lapEnd(0) - timeline.lapStart(0);
    const body1 = timeline.lapEnd(1) - timeline.lapStart(1);
    expect(body1).toBeCloseTo(body0 / LAP_SPEED_FACTOR, 9);
  });

  it('gives the rest and count-in to the lap they lead into', () => {
    const timeline = make();
    expect(timeline.lapAt(0)).toBe(0);
    expect(timeline.lapAt(timeline.lapEnd(0) - 0.001)).toBe(0);
    expect(timeline.lapAt(timeline.lapEnd(0))).toBe(1); // the rest begins
    expect(timeline.lapAt(timeline.lapStart(1) - 0.001)).toBe(1); // still counting in
    expect(timeline.lapAt(timeline.lapStart(1))).toBe(1);
    expect(timeline.lapAt(timeline.lapEnd(1))).toBe(2);
    expect(timeline.lapAt(timeline.lapStart(3) + 0.001)).toBe(3);
  });

  it('is continuous across the end of a lap and through the gap', () => {
    const timeline = make();
    const end = timeline.lapEnd(0);
    expect(timeline.rowsAt(end)).toBeCloseTo(10, 9);
    expect(timeline.rowsAt(end - 1e-6)).toBeCloseTo(10, 4);
    // The board scrolls on, empty, at the new speed.
    expect(timeline.rowsAt(end + 1)).toBeCloseTo(10 + LAP_SPEED_FACTOR * 2, 9);
    // And row 0 of the next lap is exactly where the gap ends.
    expect(timeline.rowsAt(timeline.lapStart(1))).toBeCloseTo(timeline.origin(1), 9);
    expect(timeline.rowsAt(timeline.lapStart(1) - 1e-6)).toBeCloseTo(timeline.origin(1), 4);
  });

  it('places arrivals so that the scroll position is the lap origin plus the row when a tile arrives', () => {
    const timeline = make();
    for (const [lap, row] of [[0, 0], [0, 3], [0, 9], [1, 0], [1, 4], [2, 7]] as const) {
      const at = timeline.arrival(lap, row);
      expect(timeline.rowsAt(at)).toBeCloseTo(timeline.origin(lap) + row, 9);
    }
    // The same row arrives sooner after it than before, because the song is faster.
    const gap0 = timeline.arrival(0, 5) - timeline.arrival(0, 4);
    const gap2 = timeline.arrival(2, 5) - timeline.arrival(2, 4);
    expect(gap0 / gap2).toBeCloseTo(LAP_SPEED_FACTOR ** 2, 9);
  });

  it('puts the count-in ticks before the first tile of a lap, one beat apart', () => {
    const timeline = make();
    const beat = 2; // rows
    const ticks = [0, 1, 2, 3].map((k) => timeline.arrival(2, -COUNT_IN + k * beat));
    expect(ticks[1] - ticks[0]).toBeCloseTo(beat / timeline.rate(2), 9);
    expect(timeline.lapStart(2) - ticks[3]).toBeCloseTo(beat / timeline.rate(2), 9);
    expect(ticks[0]).toBeGreaterThan(timeline.lapEnd(1));
  });

  it('gives no gap at all when no count-in is asked for beyond the rest', () => {
    const plain = new Timeline(2, 10, 5);
    expect(plain.gapRows(1)).toBe(Math.ceil(LAP_REST_SECONDS * plain.rate(1)));
  });
});
