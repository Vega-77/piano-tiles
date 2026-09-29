import { useState, type FormEvent } from 'react';
import { NAME_MAX } from '../cloud/names';

interface NameFormProps {
  /** Tries to take the name; resolves with what is wrong with it, or null once it is taken. */
  onClaim: (name: string) => Promise<string | null>;
  /** Given, shows a way to sign in with Google instead (for someone who has played before). */
  onGoogle?: () => void;
  disabled?: boolean;
}

/** Asks for the nickname a player is known by on the leaderboards. It is theirs for good, and nobody else can have it. */
export function NameForm({ onClaim, onGoogle, disabled = false }: NameFormProps) {
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const wrong = await onClaim(name);
    // (When it worked, the form is replaced, so there is nothing to put back.)
    setBusy(false);
    setProblem(wrong);
  };

  return (
    <form onSubmit={submit} className="w-full space-y-2 text-left" noValidate>
      <label htmlFor="nickname" className="block text-center text-xs font-bold uppercase tracking-widest text-white/55">
        Put your score on the leaderboard
      </label>
      <div className="flex gap-2">
        <input
          id="nickname"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={NAME_MAX}
          placeholder="Choose a nickname"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby="nickname-help"
          className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/35 ring-1 ring-white/20 focus:outline-2 focus:outline-white"
        />
        <button
          type="submit"
          disabled={busy || disabled || name.trim() === ''}
          className="btn-primary shrink-0 rounded-full px-5 py-2 text-sm font-extrabold text-white disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="text-center text-xs text-red-300">
          {problem}
        </p>
      )}
      <p id="nickname-help" className="text-center text-[0.7rem] leading-snug text-white/45">
        Letters, numbers, - and _. It is yours for good and no one else can use it.
      </p>
      {onGoogle && (
        <p className="text-center text-[0.7rem] text-white/45">
          Played before?{' '}
          <button type="button" onClick={onGoogle} className="font-bold text-white/80 underline underline-offset-2">
            Sign in with Google
          </button>
        </p>
      )}
    </form>
  );
}
