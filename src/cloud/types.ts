import type { ChartFile } from '../songs/chart';

/** The audio of a song in the cloud: what it is, and how many pieces it was cut into. */
export interface RemoteAudio {
  /** The audio's file name in the chart (`audio-<fingerprint>.<ext>`), so the name tells whether it is the same sound. */
  name: string;
  type: string;
  size: number;
  parts: number;
}

/** A published song as the cloud has it: one chart, and the audio it plays over. */
export interface RemoteSong {
  id: string;
  /** When this version was published, as in `ChartFile.savedAt`. */
  savedAt: number;
  chart: ChartFile;
  audio: RemoteAudio;
}

/** For a transfer that takes a while: how far along it is (0–1), and a way to stop it. */
export interface Transfer {
  progress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * The published songs, which everybody plays. Anyone can read them; only an admin can change them
 * (firestore.rules). `catalog.ts` is the real one; `testing.ts` has a stand-in.
 */
export interface Catalog {
  /** Every published song. Rejects if the cloud can't be reached (never answers from a stale copy). */
  list(): Promise<RemoteSong[]>;
  getAudio(id: string, audio: RemoteAudio, transfer?: Transfer): Promise<Blob>;
  /** Stores the audio. Do this before `putSong`, so a song is never there without its sound. */
  putAudio(id: string, name: string, audio: Blob, transfer?: Transfer): Promise<RemoteAudio>;
  /** Stores the chart, pointing at audio that is already stored. */
  putSong(chart: ChartFile, audio: RemoteAudio): Promise<void>;
  /** Takes a song out: its chart first (so it stops being offered), then its audio. */
  remove(id: string, audio: RemoteAudio): Promise<void>;
}

/** One player's best run on one song, as the leaderboard has it. */
export interface Score {
  uid: string;
  name: string;
  score: number;
  laps: number;
  chain: number;
}

/** A player's own place on a song's leaderboard (1 is the best). */
export interface Standing {
  score: Score;
  rank: number;
}

/** What a finished run puts on the board. */
export interface Run {
  uid: string;
  name: string;
  score: number;
  laps: number;
  chain: number;
}

/** The leaderboards, one per published song. Anyone can read them; a player can only write their own entry. */
export interface Scores {
  top(songId: string, count: number): Promise<Score[]>;
  /** The player's own entry and where it stands, or undefined if they have none. */
  standing(songId: string, uid: string): Promise<Standing | undefined>;
  /** Puts the run on the board if it beats the player's entry there; says whether it did. */
  submit(songId: string, run: Run): Promise<boolean>;
  /** Empties a song's leaderboard and says how many entries it had. Only an admin's account is let to (firestore.rules). */
  clear(songId: string): Promise<number>;
}

/** The names players play under, and who may publish songs. */
export interface Players {
  /** The name this account plays under, or null if it has none yet. */
  name(uid: string): Promise<string | null>;
  /** Whether this account is one of the admins (the ones who may publish songs). */
  isAdmin(uid: string): Promise<boolean>;
  /** Takes a name for this account, for good. Rejects with a `CloudError` if somebody has it already. */
  claim(uid: string, name: string): Promise<void>;
}

/** Who is signed in. */
export interface CloudAccount {
  uid: string;
  /** What to call them on screen when they have no nickname: their Google name or email, or "Guest". */
  name: string;
  /** A guest has signed in with nothing but a nickname, so the account lives in this browser only. */
  guest: boolean;
}

/** Signing in, and the cloud's three parts. `firebase.ts` is the real one. */
export interface CloudBackend {
  /** Starts loading what the cloud needs, so a sign-in window can open the moment it is asked for (before the click is forgotten). */
  warmUp(): void;
  /** Tells who is signed in, now and whenever that changes (null: nobody). Returns a function that stops listening. */
  watch(listener: (account: CloudAccount | null) => void, onError: (error: unknown) => void): () => void;
  /** Signs in with nothing but a new, anonymous account (the guest a nickname belongs to). */
  signInAsGuest(): Promise<CloudAccount>;
  /** Signs in with Google. A guest who does keeps their nickname and scores (the account is upgraded), unless the Google account is already known here. */
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  catalog(): Promise<Catalog>;
  scores(): Promise<Scores>;
  players(): Promise<Players>;
}
