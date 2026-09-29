import { useRef, type ChangeEvent } from 'react';
import { SONG_FILE_EXTENSION } from '../songs/bundle';

/**
 * What the file picker offers: audio and video, and the song files this app saves. (A dropped file
 * isn't checked against this, and the browser decides what it can actually read.)
 */
const ACCEPT = `audio/*,video/*,.mp3,.mp4,.m4a,.wav,.ogg,.flac,.webm,.mov,.aac,.opus,${SONG_FILE_EXTENSION}`;

interface ImportPanelProps {
  busy: boolean;
  /** False when this browser can't keep songs (a private window, say): they last until the page closes. */
  persistent: boolean;
  onFile: (file: File) => void;
}

/** The way to add a song: a drop zone. The listening is done here, in the browser; tuning comes after. */
export function ImportPanel({ busy, persistent, onFile }: ImportPanelProps) {
  const input = useRef<HTMLInputElement>(null);

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // (so the same file can be picked again)
    if (file) onFile(file);
  };

  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept={ACCEPT} onChange={chosen} className="hidden" tabIndex={-1} />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="flex w-full flex-col items-center gap-1 rounded-2xl px-4 py-4 text-center text-sm text-white/80 border-2 border-dashed border-white/25 transition hover:bg-white/5 hover:border-white/45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        <span className="font-bold">Add your own song</span>
        <span className="text-xs text-white/50">Choose or drop an mp4 or an audio file. It stays on this device.</span>
      </button>

      {!persistent && (
        <p className="px-2 text-center text-[0.7rem] leading-snug text-amber-200/80">
          This browser can’t keep songs, so anything you add lasts only until you close the page.
        </p>
      )}
    </div>
  );
}
