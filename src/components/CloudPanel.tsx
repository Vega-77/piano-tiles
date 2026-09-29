import type { Cloud } from '../hooks/useCloud';

const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Spinner() {
  return <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-white" aria-hidden />;
}

function CloudIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7Z" />
    </svg>
  );
}

const pill = 'btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:cursor-wait disabled:opacity-50';

/**
 * Signing in with Google, so the songs follow the player to other devices, and what the syncing is
 * doing. Optional: with nobody signed in the game is exactly as it was, and the songs stay put.
 */
export function CloudPanel({ cloud }: { cloud: Cloud }) {
  const { account, connecting, syncing, lastSynced, error, notes } = cloud;

  return (
    <div className="mx-auto mt-3 max-w-md space-y-1.5 text-xs text-white/70">
      {account ? (
        <div className="flex items-center justify-center gap-2">
          <CloudIcon />
          <div className="min-w-0 text-left">
            <p className="truncate font-semibold text-white/85" title={account.name}>
              {account.name}
            </p>
            <p role="status" className="flex items-center gap-1.5 truncate text-white/55">
              {syncing ? (
                <>
                  <Spinner />
                  <span className="truncate">{syncing}</span>
                </>
              ) : lastSynced ? (
                `Synced ${clock(lastSynced)}`
              ) : (
                'Signed in'
              )}
            </p>
          </div>
          <button type="button" className={pill} disabled={syncing !== null} onClick={() => void cloud.syncNow()}>
            Sync now
          </button>
          <button type="button" className={pill} onClick={() => void cloud.signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            disabled={connecting}
            // (Loading Firebase starts as the finger goes down, so the sign-in window can open straight after the click.)
            onPointerDown={cloud.warmUp}
            onFocus={cloud.warmUp}
            onClick={() => void cloud.signIn()}
            className="btn-ghost flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60"
          >
            {connecting ? <Spinner /> : <CloudIcon />}
            {connecting ? 'Connecting…' : 'Sign in with Google to sync'}
          </button>
          <p className="text-[0.7rem] text-white/45">Optional. Your songs follow you to your other devices.</p>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start justify-center gap-2 rounded-xl bg-red-500/15 px-3 py-2 text-left leading-snug text-red-100 ring-1 ring-red-400/40">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" className={pill} onClick={cloud.dismissError}>
            OK
          </button>
        </p>
      )}

      {account &&
        notes.map((note) => (
          <p key={note.id} className="rounded-xl bg-amber-400/10 px-3 py-2 text-left leading-snug text-amber-200 ring-1 ring-amber-300/30">
            <strong className="font-bold">“{note.title}”</strong> isn’t synced. {note.reason}
          </p>
        ))}
    </div>
  );
}
