import type { ChartFile } from '../songs/chart';

/** The audio of a song in the cloud: what it is, and how many pieces it was cut into. */
export interface RemoteAudio {
  /** The audio's file name in the chart (`audio-<fingerprint>.<ext>`), so the name tells whether it is the same sound. */
  name: string;
  type: string;
  size: number;
  parts: number;
}

/** A song as the cloud has it. A song that was removed is kept as a note saying so (`deleted`), so other devices can remove it too. */
export interface RemoteSong {
  id: string;
  /** When it was last changed (or removed), as in `ChartFile.savedAt`. */
  savedAt: number;
  deleted: boolean;
  chart: ChartFile | null;
  audio: RemoteAudio | null;
}

/** For a transfer that takes a while: how far along it is (0–1), and a way to stop it. */
export interface Transfer {
  progress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Where a signed-in account's songs are kept online. `firestore.ts` is the real one; `testing.ts` has a stand-in. */
export interface CloudSongs {
  /** Every song there is, removed ones included. Rejects if the cloud can't be reached (never answers from a stale copy). */
  list(): Promise<RemoteSong[]>;
  /** Stores the audio. Do this before `putSong`, so a song is never there without its sound. */
  putAudio(id: string, name: string, audio: Blob, transfer?: Transfer): Promise<RemoteAudio>;
  /** Stores the chart, pointing at audio that is already stored. */
  putSong(chart: ChartFile, audio: RemoteAudio): Promise<void>;
  /** Deletes the pieces of some audio that no chart points at any more. */
  dropAudio(id: string, audio: RemoteAudio): Promise<void>;
  getAudio(id: string, audio: RemoteAudio, transfer?: Transfer): Promise<Blob>;
  /** Marks the song as removed (as of `removedAt`) and deletes its audio. */
  remove(id: string, removedAt: number, audio: RemoteAudio | null): Promise<void>;
}

/** Who is signed in. */
export interface CloudAccount {
  uid: string;
  /** What to call them on screen: their name, or else their email. */
  name: string;
}

/** Signing in and getting at the songs of whoever did. `firebase.ts` is the real one. */
export interface CloudBackend {
  /** Starts loading what signing in needs, so its window can open the moment it is asked for (before the click is forgotten). */
  warmUp(): void;
  /** Tells who is signed in, now and whenever that changes (null: nobody). Returns a function that stops listening. */
  watch(listener: (account: CloudAccount | null) => void, onError: (error: unknown) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  songs(account: CloudAccount): Promise<CloudSongs>;
}
