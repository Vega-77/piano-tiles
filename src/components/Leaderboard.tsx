import { useCallback, useEffect, useState } from 'react';
import { describeCloudError } from '../cloud/errors';
import type { Board } from '../hooks/useCloud';

interface BoardTableProps {
  board: Board;
  /** The account looking at the board, whose own line is picked out. */
  uid?: string;
  /** How many places to show. */
  limit?: number;
}

/** The best runs on a song, and the player's own place if it is further down. */
export function BoardTable({ board, uid, limit = 10 }: BoardTableProps) {
  const shown = board.top.slice(0, limit);
  const mine = board.mine;
  const listed = mine !== undefined && shown.some((entry) => entry.uid === mine.score.uid);

  if (shown.length === 0) {
    return <p className="py-1 text-center text-xs text-white/50">No scores yet. Yours could be the first.</p>;
  }

  const row = (rank: number, name: string, score: number, own: boolean) => (
    <li
      key={`${rank}-${name}`}
      className={`flex items-baseline gap-2 rounded-lg px-2 py-1 text-xs tabular-nums ${own ? 'bg-white/15 font-bold text-white' : 'text-white/75'}`}
    >
      <span className="w-6 shrink-0 text-right text-white/45">{rank}</span>
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      <span className="shrink-0">{score.toLocaleString()}</span>
    </li>
  );

  return (
    <ol className="space-y-0.5" aria-label="Leaderboard">
      {shown.map((entry, index) => row(index + 1, entry.name, entry.score, entry.uid === uid))}
      {mine && !listed && (
        <>
          <li aria-hidden className="text-center text-xs leading-none text-white/30">
            ⋮
          </li>
          {row(mine.rank, mine.score.name, mine.score.score, true)}
        </>
      )}
    </ol>
  );
}

interface LeaderboardProps {
  songId: string;
  load: (songId: string) => Promise<Board>;
  uid?: string;
}

/** A song's leaderboard from the cloud, with what it is doing (fetching, or why it can't). */
export function Leaderboard({ songId, load, uid }: LeaderboardProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let current = true;
    setBoard(null);
    setProblem(null);
    load(songId).then(
      (loaded) => current && setBoard(loaded),
      (failure) => {
        if (!current) return;
        console.error('Loading the leaderboard failed', failure);
        setProblem(describeCloudError(failure) ?? 'The leaderboard could not be loaded.');
      },
    );
    return () => {
      current = false;
    };
  }, [songId, load, uid, tries]);

  const retry = useCallback(() => setTries((n) => n + 1), []);

  return (
    <section className="rise-in mt-2 rounded-2xl bg-white/[0.06] px-3 py-2 ring-1 ring-white/10" aria-label="Leaderboard">
      <h4 className="mb-1 text-center text-[0.65rem] font-bold uppercase tracking-widest text-white/45">Leaderboard</h4>
      {board ? (
        <BoardTable board={board} uid={uid} />
      ) : problem ? (
        <div className="flex items-center justify-between gap-3 text-xs text-amber-200/90">
          <p className="min-w-0 flex-1">{problem}</p>
          <button type="button" onClick={retry} className="btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold text-white">
            Try again
          </button>
        </div>
      ) : (
        <p role="status" className="py-1 text-center text-xs text-white/50">
          Loading…
        </p>
      )}
    </section>
  );
}
