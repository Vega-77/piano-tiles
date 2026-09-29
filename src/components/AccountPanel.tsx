import { useState } from 'react';
import type { Cloud } from '../hooks/useCloud';

interface AccountPanelProps {
  cloud: Pick<Cloud, 'account' | 'nickname' | 'admin' | 'checking' | 'signingIn' | 'error' | 'signInWithGoogle' | 'signOut' | 'dismissError'>;
}

const link = 'font-bold text-white/85 underline underline-offset-2 hover:text-white disabled:cursor-wait disabled:opacity-50';

/** Copies text where the browser lets it, and says whether it did. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Under the title: who is playing. A guest is known by the nickname they chose after a run, and can
 * sign in with Google to keep it on other devices; a Google account can sign out. An account that is
 * not an admin shows its id, which is what is put in the `admins` collection to make it one.
 */
export function AccountPanel({ cloud }: AccountPanelProps) {
  const { account, nickname, admin, checking, signingIn, error, signInWithGoogle, signOut, dismissError } = cloud;
  const [copied, setCopied] = useState<boolean | null>(null);

  if (checking && !account) return null;

  return (
    <div className="mx-auto mt-2 max-w-sm space-y-1 text-xs text-white/60">
      {account === null ? (
        <p>
          Played before?{' '}
          <button type="button" disabled={signingIn} onClick={() => void signInWithGoogle()} className={link}>
            {signingIn ? 'Signing in…' : 'Sign in with Google'}
          </button>
        </p>
      ) : (
        <p>
          Playing as <span className="font-bold text-white">{nickname ?? account.name}</span>
          {admin && <span className="ml-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-white/80">Admin</span>}
          {' · '}
          {account.guest ? (
            <button type="button" disabled={signingIn} onClick={() => void signInWithGoogle()} className={link}>
              {signingIn ? 'Signing in…' : 'Keep it with Google'}
            </button>
          ) : (
            <button type="button" onClick={() => void signOut()} className={link}>
              Sign out
            </button>
          )}
        </p>
      )}

      {account && !account.guest && !admin && (
        <details className="text-[0.7rem] text-white/40">
          <summary className="cursor-pointer select-none">Account id</summary>
          <p className="mt-1 break-all">
            <code className="select-all text-white/60">{account.uid}</code>{' '}
            <button
              type="button"
              className={link}
              onClick={async () => {
                setCopied(await copy(account.uid));
              }}
            >
              {copied === null ? 'Copy' : copied ? 'Copied' : 'Select and copy it'}
            </button>
          </p>
        </details>
      )}

      {error && (
        <p role="alert" className="flex items-start justify-center gap-2 text-red-300">
          <span className="min-w-0">{error}</span>
          <button type="button" onClick={dismissError} className="shrink-0 font-bold underline underline-offset-2">
            OK
          </button>
        </p>
      )}
    </div>
  );
}
