import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCloudError } from '../cloud/errors';
import type { Board, Cloud, RunScore } from '../hooks/useCloud';
import { BoardTable } from './Leaderboard';
import { NameForm } from './NameForm';

interface RunStandingProps {
  songId: string;
  run: RunScore;
  cloud: Pick<Cloud, 'account' | 'nickname' | 'checking' | 'claimName' | 'submit' | 'signInWithGoogle'>;
}

type Sent = Board & { improved: boolean };

/**
 * What a finished run does for the leaderboard: asks for a nickname if the player has none, sends
 * the run once they have one, and shows where it put them. (The run only counts if it beats their
 * best on this song.)
 */
export function RunStanding({ songId, run, cloud }: RunStandingProps) {
  const { account, nickname, checking, claimName, submit, signInWithGoogle } = cloud;
  const [sent, setSent] = useState<Sent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  /** A name is being taken (and a guest account made for it), which the form should stay through. */
  const [claiming, setClaiming] = useState(false);
  /** The run and try that have been sent, so a re-render (or a name found late) doesn't send it twice. */
  const done = useRef<string | null>(null);

  const named = typeof nickname === 'string';
  const { score, laps, chain } = run;
  useEffect(() => {
    if (!named) return;
    const ticket = `${songId}|${score}|${tries}`;
    if (done.current === ticket) return;
    done.current = ticket;
    setProblem(null);
    // (A result that arrives after another try has begun, or after leaving, is not this run's to show.)
    submit(songId, { score, laps, chain }).then(
      (result) => {
        if (done.current === ticket) setSent(result);
      },
      (failure) => {
        if (done.current !== ticket) return;
        console.error('Sending the score failed', failure);
        done.current = null; // (so trying again sends it)
        setProblem(describeCloudError(failure) ?? 'The score could not be sent.');
      },
    );
  }, [named, songId, score, laps, chain, tries, submit]);

  const retry = useCallback(() => setTries((n) => n + 1), []);
  const claim = useCallback(
    async (name: string) => {
      setClaiming(true);
      try {
        return await claimName(name);
      } finally {
        setClaiming(false);
      }
    },
    [claimName],
  );

  if (!named) {
    if (claiming || nickname === null || (!account && !checking)) {
      return <NameForm onClaim={claim} onGoogle={() => void signInWithGoogle()} />;
    }
    return (
      <p role="status" className="text-xs text-white/50">
        Checking your name…
      </p>
    );
  }

  if (problem) {
    return (
      <div role="alert" className="w-full space-y-2 text-center text-xs text-amber-200/90">
        <p>{problem}</p>
        <button type="button" onClick={retry} className="btn-ghost rounded-full px-4 py-1.5 text-xs font-bold text-white">
          Send the score again
        </button>
      </div>
    );
  }

  if (!sent) {
    return (
      <p role="status" className="text-xs text-white/50">
        Sending your score…
      </p>
    );
  }

  const rank = sent.mine?.rank;
  return (
    <div className="w-full space-y-2">
      <p className="text-center text-sm font-bold text-white">
        {sent.improved ? 'New best on the leaderboard' : 'Your best on the leaderboard stays'}
        {rank !== undefined && <span className="ml-2 text-white/60">#{rank}</span>}
      </p>
      <BoardTable board={sent} uid={account?.uid} limit={5} />
    </div>
  );
}
