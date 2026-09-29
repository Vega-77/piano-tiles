// v3: every player's scores were reset (2026-09-29), so nothing recorded before is carried over.
// (v2 was when scores became points, with timing and chain bonuses, rather than tile counts.)
const STATS_KEY = 'piano-tiles:songs:v3';
/** Records from before a reset: never read again, and cleared out of the way. */
const OLD_KEYS = ['piano-tiles:songs:v2'];

export interface SongStats {
  best: number;
  plays: number;
  /** Longest run of consecutive perfects on this song. */
  bestChain: number;
  /** Most full laps of the song completed in one run. */
  bestLaps: number;
}

export type StatsMap = Record<string, SongStats>;

export interface RunResult {
  score: number;
  maxChain: number;
  laps: number;
}

const EMPTY: SongStats = { best: 0, plays: 0, bestChain: 0, bestLaps: 0 };

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function loadStats(): StatsMap {
  const stats: StatsMap = {};
  try {
    for (const old of OLD_KEYS) localStorage.removeItem(old);
    const raw = localStorage.getItem(STATS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [id, value] of Object.entries(parsed)) {
        const v = (value ?? {}) as Partial<SongStats>;
        stats[id] = {
          best: toCount(v.best),
          plays: toCount(v.plays),
          bestChain: toCount(v.bestChain),
          bestLaps: toCount(v.bestLaps),
        };
      }
    }
  } catch {
    // Storage can be unavailable or corrupted; start fresh.
  }
  return stats;
}

export function getBest(songId: string): number {
  return loadStats()[songId]?.best ?? 0;
}

/** Record a finished run and report whether it beat the previous best score. */
export function recordRun(songId: string, run: RunResult): { stats: SongStats; isNewBest: boolean } {
  const all = loadStats();
  const previous = all[songId] ?? EMPTY;
  const stats: SongStats = {
    best: Math.max(previous.best, run.score),
    plays: previous.plays + 1,
    bestChain: Math.max(previous.bestChain, run.maxChain),
    bestLaps: Math.max(previous.bestLaps, run.laps),
  };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({ ...all, [songId]: stats }));
  } catch {
    // The score just won't persist.
  }
  return { stats, isNewBest: run.score > previous.best };
}
