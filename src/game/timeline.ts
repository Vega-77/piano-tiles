import { LAP_SPEED_FACTOR } from '../config';

const MAX_LAPS = 64;

/**
 * The song's clock. Everything on screen and in the music is placed by this one function of
 * time, so the tiles and the audio can never drift apart.
 *
 * Positions are measured in "rows scrolled": 0 is the moment the very first tile reaches the
 * bar. Each lap of the song is `rowsPerLap` rows long, and lap `n` scrolls at
 * `baseRate * LAP_SPEED_FACTOR ** n` rows per second, so the tempo jumps every time the song
 * finishes.
 */
export class Timeline {
  private readonly baseRate: number;
  private readonly rowsPerLap: number;
  private readonly startTime: number;

  /**
   * @param baseRate rows per second on the first lap
   * @param rowsPerLap total rows in one lap of the song
   * @param startTime song time (seconds) at which the first tile reaches the bar
   */
  constructor(baseRate: number, rowsPerLap: number, startTime: number) {
    this.baseRate = baseRate;
    this.rowsPerLap = rowsPerLap;
    this.startTime = startTime;
  }

  /** How much faster than lap 0 the given lap runs. */
  speedFactor(lap: number): number {
    return LAP_SPEED_FACTOR ** lap;
  }

  /** Rows per second during a lap. */
  rate(lap: number): number {
    return this.baseRate * this.speedFactor(lap);
  }

  /** Song time at which a lap begins. */
  lapStart(lap: number): number {
    let time = this.startTime;
    for (let l = 0; l < lap; l++) time += this.rowsPerLap / this.rate(l);
    return time;
  }

  /** Which lap the given song time falls in (0 before the song starts). */
  lapAt(time: number): number {
    let lap = 0;
    while (lap < MAX_LAPS && time >= this.lapStart(lap + 1)) lap++;
    return lap;
  }

  /** Song time at which `row` rows into the given lap reaches the bar. */
  arrival(lap: number, row: number): number {
    return this.lapStart(lap) + row / this.rate(lap);
  }

  /** How many rows have scrolled past the bar's start position at the given song time. */
  rowsAt(time: number): number {
    if (time <= this.startTime) return (time - this.startTime) * this.baseRate;
    const lap = this.lapAt(time);
    return lap * this.rowsPerLap + (time - this.lapStart(lap)) * this.rate(lap);
  }
}
