import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRemovals } from '../cloud/removals';
import { createFakeBackend, type FakeBackend } from '../cloud/testing';
import { createMemoryStore, type SongStore } from '../songs/store';
import { fakeChart } from '../songs/testing';
import { useCloud, type Cloud, type CloudOptions } from './useCloud';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cloud: Cloud;
function Probe(options: CloudOptions) {
  cloud = useCloud(options);
  return null;
}

let mounted: Root[] = [];

interface Setup {
  backend: FakeBackend;
  store: SongStore;
  refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/** Runs the hook against a fake sign-in and a cloud kept in memory. */
async function mount({ signedIn = false, restore = false } = {}): Promise<Setup> {
  const backend = createFakeBackend({ uid: 'u1', name: 'Pat' });
  if (signedIn) backend.account = { uid: 'u1', name: 'Pat' };
  const store = createMemoryStore();
  const refresh = vi.fn(async () => undefined);
  const root = createRoot(document.createElement('div'));
  mounted.push(root);
  await act(async () => {
    root.render(createElement(Probe, { refresh, backend, store: async () => store, removals: createMemoryRemovals(), restore }));
  });
  return { backend, store, refresh };
}

/** Lets the sign-in, the sync and what follows them finish. */
const settle = (ms = 20) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const song = (id: string, savedAt: number) => fakeChart(id, { savedAt, audio: `${id}-1.mp3` });
const sound = () => new Blob([new Uint8Array(64)], { type: 'audio/mpeg' });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => mounted.forEach((root) => root.unmount()));
  mounted = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('signing in to sync', () => {
  it('does nothing, and loads nothing, until someone signs in', async () => {
    const { backend } = await mount();
    await settle();
    expect(cloud.account).toBeNull();
    expect(cloud.connecting).toBe(false);
    expect(backend.warmed).toBe(0);
    expect(backend.clouds.size).toBe(0);
  });

  it('warms the sign-in up when asked to', async () => {
    const { backend } = await mount();
    cloud.warmUp();
    expect(backend.warmed).toBe(1);
  });

  it('sends the songs on this device up once signed in, and remembers the sign-in for next time', async () => {
    const { backend, store } = await mount();
    await store.save(song('a', 50), sound());

    await act(async () => void cloud.signIn());
    await settle();

    expect(cloud.account).toEqual({ uid: 'u1', name: 'Pat' });
    expect(cloud.syncing).toBeNull();
    expect(cloud.lastSynced).not.toBeNull();
    expect(cloud.error).toBeNull();
    expect(backend.clouds.get('u1')!.songs.get('a')).toMatchObject({ savedAt: 50, deleted: false });
    expect(localStorage.getItem('piano-tiles-cloud')).toBe('1');
  });

  it('takes songs down from the cloud and has the library read again', async () => {
    const { backend, store, refresh } = await mount();
    const there = await backend.songs({ uid: 'u1', name: 'Pat' });
    const audio = await there.putAudio('b', 'b-1.mp3', sound());
    await there.putSong(song('b', 70), audio);

    await act(async () => void cloud.signIn());
    await settle();

    expect(await store.chart('b')).toMatchObject({ id: 'b', savedAt: 70 });
    expect((await store.audio('b'))!.size).toBe(64);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not have the library read again when nothing came down', async () => {
    const { store, refresh } = await mount();
    await store.save(song('a', 50), sound());
    await act(async () => void cloud.signIn());
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('finds someone who was signed in already, when the page opens', async () => {
    await mount({ signedIn: true, restore: true });
    await settle();
    expect(cloud.connecting).toBe(false);
    expect(cloud.account?.name).toBe('Pat');
  });

  it('forgets the sign-in, and stops syncing, on sign-out', async () => {
    const { backend, store } = await mount();
    await act(async () => void cloud.signIn());
    await settle();

    await act(async () => void cloud.signOut());
    await settle();
    expect(cloud.account).toBeNull();
    expect(cloud.lastSynced).toBeNull();
    expect(localStorage.getItem('piano-tiles-cloud')).toBeNull();

    await store.save(song('late', 90), sound());
    cloud.syncSoon();
    await settle(5000);
    expect(backend.clouds.get('u1')!.songs.has('late')).toBe(false);
  });
});

describe('syncing after a change', () => {
  it('waits a moment, so a run of changes is one sync', async () => {
    const { backend, store } = await mount({ signedIn: true, restore: true });
    await settle();
    const there = backend.clouds.get('u1')!;
    there.calls.length = 0;

    await store.save(song('a', 50), sound());
    cloud.syncSoon();
    await settle(500);
    await store.save(song('b', 51), sound());
    cloud.syncSoon();
    await settle(1000);
    expect(there.calls).toEqual([]); // (still waiting: the second change moved it back)

    await settle(1000);
    expect(there.calls.filter((call) => call === 'list')).toHaveLength(1);
    expect([...there.songs.keys()].sort()).toEqual(['a', 'b']);
  });

  it('syncs again when the connection comes back', async () => {
    const { backend, store } = await mount({ signedIn: true, restore: true });
    await settle();
    const there = backend.clouds.get('u1')!;
    await store.save(song('a', 50), sound());

    await act(async () => void window.dispatchEvent(new Event('online')));
    await settle();

    expect(there.songs.has('a')).toBe(true);
  });

  it('does not sync on returning to the page straight after a sync, but does after a while', async () => {
    const { backend } = await mount({ signedIn: true, restore: true });
    await settle();
    const there = backend.clouds.get('u1')!;
    there.calls.length = 0;

    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(there.calls).toEqual([]);

    await settle(61_000);
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(there.calls).toEqual(['list']);
  });
});

describe('when something goes wrong', () => {
  it('says so in plain words when the cloud cannot be reached, and tries again on request', async () => {
    const { backend, store } = await mount();
    await store.save(song('a', 50), sound());
    const there = await backend.songs({ uid: 'u1', name: 'Pat' });
    (there as unknown as { offline: boolean }).offline = true;

    await act(async () => void cloud.signIn());
    await settle();
    expect(cloud.error).toMatch(/Couldn't reach the cloud/);
    expect(cloud.syncing).toBeNull();
    expect(cloud.account).not.toBeNull(); // (still signed in: only the sync failed)

    (there as unknown as { offline: boolean }).offline = false;
    await act(async () => void cloud.syncNow());
    await settle();
    expect(cloud.error).toBeNull();
    expect((there as unknown as { songs: Map<string, unknown> }).songs.has('a')).toBe(true);
  });

  it('says nothing when the player closes the sign-in window', async () => {
    const { backend } = await mount();
    backend.failSignIn = Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' });
    await act(async () => void cloud.signIn());
    await settle();
    expect(cloud.error).toBeNull();
    expect(cloud.connecting).toBe(false);
    expect(cloud.account).toBeNull();
  });

  it('says what to do when the browser blocks the sign-in window, and lets the message be dismissed', async () => {
    const { backend } = await mount();
    backend.failSignIn = Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' });
    await act(async () => void cloud.signIn());
    await settle();
    expect(cloud.error).toMatch(/pop-ups/);

    await act(async () => cloud.dismissError());
    expect(cloud.error).toBeNull();
  });

  it('says what to do when the database turns it away', async () => {
    const { backend, store } = await mount();
    await store.save(song('a', 50), sound());
    const there = await backend.songs({ uid: 'u1', name: 'Pat' });
    there.list = async () => {
      throw Object.assign(new Error('no'), { code: 'permission-denied' });
    };
    await act(async () => void cloud.signIn());
    await settle();
    expect(cloud.error).toMatch(/rules/);
  });
});
