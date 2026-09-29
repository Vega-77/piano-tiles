import { firebaseConfig } from './config';
import { createFirestoreSongs } from './firestore';
import type { CloudAccount, CloudBackend } from './types';

/**
 * Firebase is loaded only when it is wanted (at a sign-in, or at the start for someone who was
 * signed in before), so a visit that never touches the cloud doesn't download any of it.
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

const accountOf = (user: { uid: string; displayName: string | null; email: string | null }): CloudAccount => ({
  uid: user.uid,
  name: user.displayName || user.email || 'your account',
});

/** Sign in with Google, and the songs in Firestore, both through the Firebase project in config.ts. */
export const firebaseBackend: CloudBackend = {
  warmUp() {
    void connection().catch(() => undefined); // (a failure is met again, and shown, when it matters)
  },

  watch(listener, onError) {
    let stopped = false;
    let stop: (() => void) | undefined;
    connection().then(
      ({ auth, session }) => {
        if (stopped) return;
        stop = auth.onAuthStateChanged(session, (user) => listener(user ? accountOf(user) : null), onError);
      },
      onError,
    );
    return () => {
      stopped = true;
      stop?.();
    };
  },

  async signIn() {
    const { auth, session } = await connection();
    await auth.signInWithPopup(session, new auth.GoogleAuthProvider());
  },

  async signOut() {
    const { auth, session } = await connection();
    await auth.signOut(session);
  },

  async songs(account) {
    const { firestore, db } = await connection();
    return createFirestoreSongs(firestore, db, account.uid);
  },
};
