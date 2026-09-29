/**
 * The Firebase project the songs are synced through. These values only say which project to talk
 * to; they are not secrets and every Firebase web app ships them. What keeps other people out is
 * `firestore.rules`, which lets a signed-in account touch nothing but its own songs.
 *
 * Only sign-in (Auth) and the database (Firestore) are used, both on the free Spark plan. There is
 * no Cloud Storage (it needs a paid plan) and no Analytics.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyD2pRXDqF1hddUWg7c5CEobsn8v-r9pBT0',
  authDomain: 'pianotiles-4bb41.firebaseapp.com',
  projectId: 'pianotiles-4bb41',
  messagingSenderId: '465448646428',
  appId: '1:465448646428:web:65d90c9ed29853fffbecd9',
} as const;

/**
 * The biggest audio a song may have to be kept in the cloud. The free database holds 1 GiB in all,
 * and each song is stored in pieces a little under 1 MB (its limit for one document). A bigger
 * song stays on the device it was added on, and can still be moved as a song file.
 */
export const MAX_CLOUD_AUDIO_BYTES = 40 * 1024 * 1024;
