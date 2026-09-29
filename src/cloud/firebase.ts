import { firebaseConfig } from './config';
import { createFirestorePlayers, createFirestoreScores } from './board';
import { createFirestoreCatalog } from './catalog';
import type { CloudAccount, CloudBackend } from './types';

/**
 * Firebase is loaded on its own, in the background, once the page is up (the songs everyone plays
 * come from it), so the menu doesn't wait for it.
 */
async function load() {
  const [app, auth, firestore] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
  const started = app.initializeApp(firebaseConfig);
  return {
    auth,
    firestore,
    session: auth.getAuth(started),
    // (Long polling is what a network that blocks streaming needs; it is only used if the first try fails.)
    db: firestore.initializeFirestore(started, { experimentalAutoDetectLongPolling: true }),
  };
}

let loading: ReturnType<typeof load> | undefined;
const connection = () =>
  (loading ??= load().catch((error) => {
    loading = undefined; // (a later try may work)
    throw error;
  }));

type SignedIn = {
  uid: string;
  displayName: string | null;
  email: string | null;
  isAnonymous: boolean;
  providerData?: readonly { displayName: string | null; email: string | null }[];
};

const accountOf = (user: SignedIn): CloudAccount => ({
  uid: user.uid,
  // (Right after a guest is upgraded, the name is only on the Google side of the account.)
  name: user.displayName || user.providerData?.find((info) => info.displayName)?.displayName || user.email || 'Guest',
  guest: user.isAnonymous,
});

/** Everyone watching who is signed in, so a change that Firebase doesn't announce (a guest upgraded to Google) can be. */
const watchers = new Set<(account: CloudAccount | null) => void>();

/** Sign-in (Google, or a guest with no details) and the songs, leaderboards and names in Firestore, all through the Firebase project in config.ts. */
export const firebaseBackend: CloudBackend = {
  warmUp() {
    void connection().catch(() => undefined); // (a failure is met again, and shown, when it matters)
  },

  watch(listener, onError) {
    let stopped = false;
    let stop: (() => void) | undefined;
    watchers.add(listener);
    connection().then(
      ({ auth, session }) => {
        if (stopped) return;
        stop = auth.onAuthStateChanged(session, (user) => listener(user ? accountOf(user) : null), onError);
      },
      onError,
    );
    return () => {
      stopped = true;
      watchers.delete(listener);
      stop?.();
    };
  },

  async signInAsGuest() {
    const { auth, session } = await connection();
    return accountOf((await auth.signInAnonymously(session)).user);
  },

  async signInWithGoogle() {
    const { auth, session } = await connection();
    const provider = new auth.GoogleAuthProvider();
    const guest = session.currentUser?.isAnonymous ? session.currentUser : null;
    if (!guest) {
      await auth.signInWithPopup(session, provider);
      return;
    }
    try {
      // The guest becomes a Google account without changing: same nickname, same scores.
      await auth.linkWithPopup(guest, provider);
    } catch (error) {
      // This Google account was signed in before, here or elsewhere, and has a name of its own: it is the one to use.
      const credential =
        (error as { code?: unknown } | null)?.code === 'auth/credential-already-in-use'
          ? auth.GoogleAuthProvider.credentialFromError(error as Parameters<typeof auth.GoogleAuthProvider.credentialFromError>[0])
          : null;
      if (!credential) throw error;
      await auth.signInWithCredential(session, credential);
      return;
    }
    // (Linking is not a sign-in as far as Firebase is concerned, so nothing told the page.)
    const user = session.currentUser;
    if (user) for (const listener of watchers) listener(accountOf(user));
  },

  async signOut() {
    const { auth, session } = await connection();
    await auth.signOut(session);
  },

  async catalog() {
    const { firestore, db } = await connection();
    return createFirestoreCatalog(firestore, db);
  },

  async scores() {
    const { firestore, db } = await connection();
    return createFirestoreScores(firestore, db);
  },

  async players() {
    const { firestore, db } = await connection();
    return createFirestorePlayers(firestore, db);
  },
};
