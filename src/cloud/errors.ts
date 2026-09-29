/** Something the cloud side can't do, in words that can be shown to the player. */
export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

const OFFLINE = "Couldn't reach the cloud. Check the connection; it tries again when you're back online.";

const BY_CODE: Readonly<Record<string, string>> = {
  'permission-denied':
    "The cloud database said no. Its rules may not be published yet, or this account isn't allowed to do that.",
  unauthenticated: 'The sign-in has run out. Sign in again.',
  'resource-exhausted': "The free limit of the cloud database is used up for today. Try again tomorrow.",
  unavailable: OFFLINE,
  'deadline-exceeded': OFFLINE,
  'auth/network-request-failed': OFFLINE,
  'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.',
  'auth/unauthorized-domain':
    "This site's address isn't on the sign-in allow list yet (Firebase console, Authentication, Settings, Authorized domains).",
  'auth/operation-not-allowed': "This kind of sign-in (Google or guest) isn't switched on in the Firebase console yet (Authentication, Sign-in method).",
  'auth/too-many-requests': 'Too many sign-in tries. Wait a little, then try again.',
  'auth/user-disabled': 'This account has been switched off.',
};

/** Sign-in windows the player closed themselves: not a failure, so nothing is said. */
const QUIET = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

/** Words for whatever went wrong, or undefined if it was only the player backing out. */
export function describeCloudError(error: unknown): string | undefined {
  if (error instanceof CloudError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (QUIET.has(code)) return undefined;
    // (Firestore's codes come as `firestore/unavailable` in some versions.)
    const known = BY_CODE[code] ?? BY_CODE[code.replace(/^firestore\//, '')];
    if (known) return known;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return OFFLINE;
  return 'Something went wrong with the cloud. Try again in a moment.';
}
