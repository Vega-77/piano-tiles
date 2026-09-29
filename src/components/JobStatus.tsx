import type { Working } from '../hooks/useImporter';
import type { ChartFile } from '../songs/chart';

interface JobStatusProps {
  working: Working | null;
  error: string | null;
  added: ChartFile | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/** What the song tools are doing, or just did: progress with a way to stop it, the new song, or what went wrong. */
export function JobStatus({ working, error, added, onCancel, onDismiss }: JobStatusProps) {
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
          <p className="font-semibold text-emerald-100">
            Added “{added.title}” at {Math.round(added.bpm)} BPM
          </p>
          {warnings.map((warning) => (
            <p key={warning} className="mt-1 text-xs leading-snug text-amber-200">
              {warning}
            </p>
          ))}
          <p className="mt-1 text-xs text-white/55">
            It is saved in <code>public/songs</code>: commit it to keep it.
          </p>
        </div>
        <button type="button" onClick={onDismiss} className="btn-ghost shrink-0 rounded-full px-3 py-1 text-xs font-bold">
          OK
        </button>
      </div>
    );
  }

  return null;
}
