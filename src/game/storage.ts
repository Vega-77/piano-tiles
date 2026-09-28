const HIGH_SCORE_KEY = 'piano-tiles:high-score';

export function loadHighScore(): number {
  try {
    const value = Number(localStorage.getItem(HIGH_SCORE_KEY));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

export function saveHighScore(score: number): void {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(score));
  } catch {
    // Storage can be unavailable (private mode, quota); the score just won't persist.
  }
}
