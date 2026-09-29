import type { Working } from '../hooks/useImporter';
import type { ChartFile } from '../songs/chart';

interface JobStatusProps {
  working: Working | null;
  error: string | null;
  added: ChartFile | null;
  /** False when this browser can't keep songs. */
  persistent: boolean;
  /** Whether someone is signed in, so the songs are kept in their cloud too. */
  synced?: boolean;
  onCancel: () => void;
  onDismiss: () => void;
  /** Given the song just added, opens the screen to tune it; leave out to show no button. */
  onTune?: (id: string) => void;
}

/** What is being done to a song, or just was: progress with a way to stop it, the new song, or what went wrong. */
export function JobStatus({ working, error, added, persistent, synced = false, onCancel, onDismiss, onTune }: JobStatusProps) {
  if (working) {
    return (
      <div role="status" className="rise-in mx-4 mb-2 rounded-2xl bg-white/10 p-3 text-sm ring-1 ring-white/15">
        <div className="flex items-center gap-3">
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-white"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{working.what}</p>
            <p className="truncate text-xs text-white/60">{working.stage}</p>
            <div
              role="progressbar"
              aria-label={working.what}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(working.fraction * 100)}
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/15"
            >
              <div
                className="h-full rounded-full bg-white/80 transition-[width] duration-200"
                style={{ width: `${Math.round(Math.max(0, Math.min(1, working.fraction)) * 100)}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rise-in mx-4 mb-2 flex items-start gap-3 rounded-2xl bg-red-500/15 p-3 text-sm ring-1 ring-red-400/40">
        <p className="min-w-0 flex-1 break-words text-red-100">{error}</p>
        <button type="button" onClick={onDismiss} className="btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold">
          OK
        </button>
      </div>
    );
  }

  if (added) {
    const warnings = added.analysis?.warnings ?? [];
    return (
      <div role="status" className="rise-in mx-4 mb-2 flex items-start gap-3 rounded-2xl bg-emerald-500/15 p-3 text-sm ring-1 ring-emerald-400/40">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-emerald-100">Added “{added.title}”</p>
          {warnings.map((warning) => (
            <p key={warning} className="mt-1 text-xs leading-snug text-amber-200">
              {warning}
            </p>
          ))}
          <p className="mt-1 text-xs text-white/55">
            {persistent
              ? `Saved on this device${synced ? ' and on its way to your other devices' : ''}. If the tiles don’t feel right, tune the song.`
              : 'This browser can’t keep songs, so it is gone when you close the page.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          {onTune && (
            <button type="button" onClick={() => onTune(added.id)} className="btn-ghost rounded-full px-3 py-1 text-xs font-bold">
              Tune
            </button>
          )}
          <button type="button" onClick={onDismiss} className="btn-ghost rounded-full px-3 py-1 text-xs font-bold">
            OK
          </button>
        </div>
      </div>
    );
  }

  return null;
}
