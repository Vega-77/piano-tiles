import { LAP_REST_SECONDS, LAP_SPEED_STEP } from '../config';

const MAX_LAPS = 64;

/**
 * The song's clock. Everything on screen and in the music is placed by this one function of
 * time, so the tiles and the audio can never drift apart.
 *
 * Positions are measured in "rows scrolled": 0 is the moment the very first tile reaches the
 * bar. Each lap of the song is `rowsPerLap` rows long, and lap `n` scrolls at
 * `baseRate * (1 + LAP_SPEED_STEP * n)` rows per second, so the tempo jumps every time the song
 * finishes.
 *
 * Between laps the board keeps scrolling, empty, at the new lap's speed: a rest of at least
 * `LAP_REST_SECONDS`, then `countInRows` rows for the count-in, then the first tile of the lap.
 * Those rows count in the scroll position too, so `origin(lap)` (where the lap's row 0 sits) is
 * further along than `lap * rowsPerLap`.
 */
export class Timeline {
  private readonly baseRate: number;
  private readonly rowsPerLap: number;
  private readonly startTime: number;
  private readonly countInRows: number;
  /** Cached: where each lap's row 0 sits in the scroll, and the song time it reaches the bar. */
  private readonly origins = [0];
  private readonly starts: number[];

  /**
   * @param baseRate rows per second on the first lap
   * @param rowsPerLap total rows in one lap of the song
   * @param startTime song time (seconds) at which the first tile reaches the bar
   * @param countInRows rows of count-in between the rest and each later lap's first tile
   */
  constructor(baseRate: number, rowsPerLap: number, startTime: number, countInRows = 0) {
    this.baseRate = baseRate;
    this.rowsPerLap = rowsPerLap;
    this.startTime = startTime;
    this.countInRows = countInRows;
    this.starts = [startTime];
  }

  /** How much faster than lap 0 the given lap runs. */
  speedFactor(lap: number): number {
    return 1 + LAP_SPEED_STEP * lap;
  }

  /** Rows per second during a lap. */
  rate(lap: number): number {
    return this.baseRate * this.speedFactor(lap);
  }

  /** Rows of empty board (the rest, then the count-in) in front of a lap. The first lap has none. */
  gapRows(lap: number): number {
    return lap <= 0 ? 0 : Math.ceil(LAP_REST_SECONDS * this.rate(lap)) + this.countInRows;
  }

  /** Where row 0 of a lap sits in the scroll (in rows). */
  origin(lap: number): number {
    this.extend(lap);
    return this.origins[lap];
  }

  /** Song time at which row 0 of a lap reaches the bar. */
  lapStart(lap: number): number {
    this.extend(lap);
    return this.starts[lap];
  }

  /** Song time at which a lap's last row has gone by: the rest before the next lap begins. */
  lapEnd(lap: number): number {
    return this.lapStart(lap) + this.rowsPerLap / this.rate(lap);
  }

  /**
   * Which lap the given song time belongs to (0 before the song starts). A lap belongs to the
   * time from the end of the one before it, so the rest and count-in count as part of the lap
   * they lead into.
   */
  lapAt(time: number): number {
    let lap = 0;
    while (lap < MAX_LAPS && time >= this.lapEnd(lap)) lap++;
    return lap;
  }

  /** Song time at which `row` rows into the given lap reaches the bar (negative rows are its count-in). */
  arrival(lap: number, row: number): number {
    return this.lapStart(lap) + row / this.rate(lap);
  }

  /** How many rows have scrolled past the bar's start position at the given song time. */
  rowsAt(time: number): number {
    if (time <= this.startTime) return (time - this.startTime) * this.baseRate;
    const lap = this.lapAt(time);
    return this.origin(lap) + (time - this.lapStart(lap)) * this.rate(lap);
  }

  private extend(lap: number): void {
    for (let l = this.origins.length; l <= lap; l++) {
      this.origins.push(this.origins[l - 1] + this.rowsPerLap + this.gapRows(l));
      this.starts.push(this.lapEnd(l - 1) + this.gapRows(l) / this.rate(l));
    }
  }
}
