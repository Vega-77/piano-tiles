const STATS_KEY = 'piano-tiles:songs:v1';
/** Before there were songs there was one global high score, earned on Ode to Joy. */
const LEGACY_HIGH_SCORE_KEY = 'piano-tiles:high-score';
const LEGACY_SONG_ID = 'ode-to-joy';

export interface SongStats {
  best: number;
  plays: number;
}

export type StatsMap = Record<string, SongStats>;

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function loadStats(): StatsMap {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const stats: StatsMap = {};
      if (parsed && typeof parsed === 'object') {
        for (const [id, value] of Object.entries(parsed)) {
          const { best, plays } = (value ?? {}) as Partial<SongStats>;
          stats[id] = { best: toCount(best), plays: toCount(plays) };
        }
      }
      return stats;
    }
    const legacy = toCount(localStorage.getItem(LEGACY_HIGH_SCORE_KEY));
    if (legacy > 0) return { [LEGACY_SONG_ID]: { best: legacy, plays: 0 } };
  } catch {
    // Storage can be unavailable or corrupted; start fresh.
  }
  return {};
}

export function getBest(songId: string): number {
  return loadStats()[songId]?.best ?? 0;
}

/** Record a finished run and report whether it beat the previous best. */
export function recordRun(songId: string, score: number): { stats: SongStats; isNewBest: boolean } {
  const all = loadStats();
  const previous = all[songId] ?? { best: 0, plays: 0 };
  const stats = { best: Math.max(previous.best, score), plays: previous.plays + 1 };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({ ...all, [songId]: stats }));
  } catch {
    // The score just won't persist.
  }
  return { stats, isNewBest: score > previous.best };
}
