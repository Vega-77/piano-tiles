// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ChartFile } from '../songs/chart';
import { Cancelled } from '../songs/errors';
import { createMemoryStore, type SongStore } from '../songs/store';
import { fakeChart } from '../songs/testing';
import { createMemoryRemovals } from './removals';
import { planSync, runSync, type LocalEntry, type SyncAction } from './sync';
import { createMemoryCloud, type MemoryCloud } from './testing';
import type { RemoteSong } from './types';

const here = (id: string, savedAt: number): LocalEntry => ({ id, savedAt });
const there = (id: string, savedAt: number, deleted = false): RemoteSong => ({ id, savedAt, deleted, chart: null, audio: null });
const plan = (local: LocalEntry[], remote: RemoteSong[], removed: Record<string, number> = {}): SyncAction[] =>
  planSync(local, remote, new Map(Object.entries(removed)));

describe('planning a sync', () => {
  it('does nothing when both sides have the same songs at the same times', () => {
    expect(plan([here('a', 5), here('b', 7)], [there('a', 5), there('b', 7)])).toEqual([]);
  });

  it('sends a song only this device has, and fetches one only the cloud has', () => {
    expect(plan([here('a', 5)], [there('b', 6)])).toEqual([
      { kind: 'push', id: 'a' },
      { kind: 'pull', id: 'b' },
    ]);
  });

  it('lets the newer copy win, either way round', () => {
    expect(plan([here('a', 9)], [there('a', 5)])).toEqual([{ kind: 'push', id: 'a' }]);
    expect(plan([here('a', 5)], [there('a', 9)])).toEqual([{ kind: 'pull', id: 'a' }]);
  });

  it('takes a song from before syncing (time 0) as older than anything in the cloud', () => {
    expect(plan([here('a', 0)], [there('a', 1)])).toEqual([{ kind: 'pull', id: 'a' }]);
    expect(plan([here('a', 0)], [there('a', 0)])).toEqual([]);
  });

  it('removes here what was removed elsewhere after it was last changed', () => {
    expect(plan([here('a', 5)], [there('a', 8, true)])).toEqual([{ kind: 'delete-local', id: 'a' }]);
  });

  it('keeps, and sends again, a song changed after it was removed elsewhere', () => {
    expect(plan([here('a', 9)], [there('a', 8, true)])).toEqual([{ kind: 'push', id: 'a' }]);
  });

  it('removes from the cloud a song removed here after its last change there, and forgets the note', () => {
    expect(plan([], [there('a', 5)], { a: 8 })).toEqual([
      { kind: 'delete-remote', id: 'a', removedAt: 8 },
      { kind: 'forget', id: 'a' },
    ]);
  });

  it('fetches a song changed in the cloud after it was removed here', () => {
    expect(plan([], [there('a', 9)], { a: 8 })).toEqual([
      { kind: 'forget', id: 'a' },
      { kind: 'pull', id: 'a' },
    ]);
  });

  it('tells a removed song from a new one only by the note of the removal', () => {
    expect(plan([], [there('a', 5)])).toEqual([{ kind: 'pull', id: 'a' }]);
  });

  it('does not fetch a removed song, and forgets a note the cloud has already caught up with', () => {
    expect(plan([], [there('a', 8, true)], { a: 8 })).toEqual([{ kind: 'forget', id: 'a' }]);
    expect(plan([], [], { a: 8 })).toEqual([{ kind: 'forget', id: 'a' }]);
    expect(plan([], [there('a', 8, true)])).toEqual([]);
  });

  it('forgets a note about a song that is here again', () => {
    expect(plan([here('a', 9)], [there('a', 9)], { a: 8 })).toEqual([{ kind: 'forget', id: 'a' }]);
  });

  it('lists the songs in a steady order', () => {
    const ids = plan([here('b', 1), here('a', 1), here('c', 1)], []).map((action) => action.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

// ---- running one -------------------------------------------------------------------------------

const bytes = (size: number, fill = 7) => new Blob([new Uint8Array(size).fill(fill)], { type: 'audio/mpeg' });
const chartOf = (id: string, savedAt: number | undefined, overrides: Partial<ChartFile> = {}) =>
  fakeChart(id, { audio: `${id}-1.mp3`, ...(savedAt === undefined ? {} : { savedAt }), ...overrides });

interface Device {
  store: SongStore;
  removals: ReturnType<typeof createMemoryRemovals>;
  sync: (options?: Partial<Parameters<typeof runSync>[0]>) => ReturnType<typeof runSync>;
}

function device(cloud: MemoryCloud, now = () => 1000): Device {
  const store = createMemoryStore();
  const removals = createMemoryRemovals();
  return { store, removals, sync: (options) => runSync({ store, cloud, removals, now, ...options }) };
}

const add = async ({ store }: Device, chart: ChartFile, size = 100) => store.save(chart, bytes(size));
const titles = async ({ store }: Device) => (await store.charts()).map((raw) => (raw as ChartFile).id).sort();
const called = (cloud: MemoryCloud, what: string) => cloud.calls.filter((call) => call.startsWith(what));

describe('syncing songs', () => {
  it('sends a new song: its audio first, then the song', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await add(one, chartOf('a', 50), 2000);

    const report = await one.sync();

    expect(report.pushed).toEqual(['a']);
    expect(cloud.calls).toEqual(['list', 'putAudio a', 'putSong a']);
    expect(cloud.songs.get('a')).toMatchObject({ savedAt: 50, deleted: false, audio: { name: 'a-1.mp3', size: 2000 } });
  });

  it('brings a song from one device to another, audio and all', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50), 1234);
    await phone.sync();

    const report = await laptop.sync();

    expect(report.pulled).toEqual(['a']);
    expect(await laptop.store.chart('a')).toEqual(chartOf('a', 50));
    expect((await laptop.store.audio('a'))!.size).toBe(1234);
  });

  it('does nothing the second time, and never sends or fetches audio it already has', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50));
    await phone.sync();
    await laptop.sync();
    cloud.calls.length = 0;

    expect(await phone.sync()).toMatchObject({ pushed: [], pulled: [], removedHere: [], removedThere: [] });
    expect(await laptop.sync()).toMatchObject({ pushed: [], pulled: [] });
    expect(cloud.calls).toEqual(['list', 'list']);
  });

  it('sends a change of tuning without sending the audio again, and the other device takes it without fetching it', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50), 500);
    await phone.sync();
    await laptop.sync();
    cloud.calls.length = 0;

    await phone.store.save(chartOf('a', 60, { nudge: 0.05 }));
    await phone.sync();
    await laptop.sync();

    expect(called(cloud, 'putAudio')).toEqual([]);
    expect(called(cloud, 'getAudio')).toEqual([]);
    expect(((await laptop.store.chart('a')) as ChartFile).nudge).toBe(0.05);
    expect((await laptop.store.audio('a'))!.size).toBe(500);
  });

  it('sends new audio when a song has been given different audio, and drops the old', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50), 500);
    await phone.sync();
    await laptop.sync();

    await phone.store.save(chartOf('a', 60, { audio: 'a-2.mp3' }), bytes(700, 9));
    await phone.sync();

    expect(cloud.audio.has('a|a-1.mp3')).toBe(false);
    expect(cloud.audio.has('a|a-2.mp3')).toBe(true);
    expect(called(cloud, 'dropAudio')).toEqual(['dropAudio a']);

    await laptop.sync();
    expect((await laptop.store.audio('a'))!.size).toBe(700);
    expect(((await laptop.store.chart('a')) as ChartFile).audio).toBe('a-2.mp3');
  });

  it('gives a song from before syncing a time as it is sent, and keeps its audio here', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud, () => 4242);
    await add(one, chartOf('old', undefined), 300);

    await one.sync();

    expect(((await one.store.chart('old')) as ChartFile).savedAt).toBe(4242);
    expect((await one.store.audio('old'))!.size).toBe(300);
    expect(cloud.songs.get('old')!.savedAt).toBe(4242);
    // (and so the next sync finds both copies the same)
    cloud.calls.length = 0;
    await one.sync();
    expect(cloud.calls).toEqual(['list']);
  });

  it('removes a song from the cloud when it was removed here, and from another device after that', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50));
    await phone.sync();
    await laptop.sync();

    await phone.store.remove('a');
    phone.removals.add('a', 90);
    const first = await phone.sync();

    expect(first.removedThere).toEqual(['a']);
    expect(cloud.songs.get('a')).toMatchObject({ deleted: true, savedAt: 90 });
    expect(cloud.audio.size).toBe(0);
    expect(phone.removals.all().size).toBe(0);

    const second = await laptop.sync();
    expect(second.removedHere).toEqual(['a']);
    expect(await titles(laptop)).toEqual([]);
    expect(await laptop.store.audio('a')).toBeUndefined();
  });

  it('does not bring back a song that was removed on this device, even before the cloud knows', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    await add(phone, chartOf('a', 50));
    await phone.sync();
    await phone.store.remove('a');
    phone.removals.add('a', 90);

    cloud.offline = true;
    await expect(phone.sync()).rejects.toMatchObject({ code: 'unavailable' });
    expect(await titles(phone)).toEqual([]);
    expect(phone.removals.all().get('a')).toBe(90);
  });

  it('lets a song changed after it was removed elsewhere come back', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50));
    await phone.sync();
    await laptop.sync();
    await phone.store.remove('a');
    phone.removals.add('a', 90);
    await phone.sync();

    await laptop.store.save(chartOf('a', 120, { title: 'Still here' }));
    const report = await laptop.sync();

    expect(report.pushed).toEqual(['a']);
    expect(cloud.songs.get('a')).toMatchObject({ deleted: false, savedAt: 120 });
    await phone.sync();
    expect(((await phone.store.chart('a')) as ChartFile).title).toBe('Still here');
  });

  it('keeps a song too big for the cloud on this device, and says why', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await add(one, chartOf('big', 50, { title: 'Big One' }), 5 * 1024 * 1024);
    await add(one, chartOf('small', 50), 100);

    const report = await one.sync({ maxAudioBytes: 2 * 1024 * 1024 });

    expect(report.pushed).toEqual(['small']);
    expect(report.skipped).toEqual([{ id: 'big', title: 'Big One', reason: expect.stringMatching(/5 MB.*2 MB/) }]);
    expect(cloud.songs.has('big')).toBe(false);
    expect(called(cloud, 'putAudio')).toEqual(['putAudio small']);
  });

  it('skips a song whose audio is missing here rather than sending half of it', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await one.store.save(chartOf('a', 50, { title: 'No Sound' }));

    const report = await one.sync();

    expect(report.pushed).toEqual([]);
    expect(report.skipped).toMatchObject([{ id: 'a', title: 'No Sound' }]);
    expect(cloud.songs.size).toBe(0);
  });

  it('leaves a song it cannot read alone', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await one.store.save({ ...chartOf('odd', 5), version: 2 } as unknown as ChartFile, bytes(10));
    await add(one, chartOf('fine', 5));

    const report = await one.sync();

    expect(report.pushed).toEqual(['fine']);
    expect(await titles(one)).toEqual(['fine', 'odd']);
  });

  it('does not take a song over one the player changed while it was being fetched', async () => {
    const cloud = createMemoryCloud();
    const phone = device(cloud);
    const laptop = device(cloud);
    await add(phone, chartOf('a', 50), 400);
    await phone.sync();
    await laptop.store.save(chartOf('a', 10, { audio: 'other.mp3' }), bytes(400)); // (different audio, so it has to be fetched)

    const fetch = cloud.getAudio;
    cloud.getAudio = async (...args) => {
      await laptop.store.save(chartOf('a', 77, { audio: 'other.mp3', title: 'Just tuned' })); // (the player, meanwhile)
      return fetch(...args);
    };
    const report = await laptop.sync();

    expect(report.pulled).toEqual([]);
    expect(((await laptop.store.chart('a')) as ChartFile).title).toBe('Just tuned');
  });

  it('stops when asked, and the next sync carries on', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await add(one, chartOf('a', 50));
    await add(one, chartOf('b', 50));

    const stop = new AbortController();
    stop.abort();
    await expect(one.sync({ signal: stop.signal })).rejects.toBeInstanceOf(Cancelled);
    expect(cloud.songs.size).toBe(0);

    expect((await one.sync()).pushed).toEqual(['a', 'b']);
  });

  it('reports what it is doing as it goes', async () => {
    const cloud = createMemoryCloud();
    const one = device(cloud);
    await add(one, chartOf('a', 50, { title: 'Song A' }));
    const said: string[] = [];

    await one.sync({ onProgress: (message) => said.push(message) });

    expect(said[0]).toBe('Checking the cloud');
  });

  it('fails plainly when the cloud cannot be reached, and touches nothing here', async () => {
    const cloud = createMemoryCloud();
    cloud.offline = true;
    const one = device(cloud);
    await add(one, chartOf('a', 50));

    await expect(one.sync()).rejects.toMatchObject({ code: 'unavailable' });
    expect(await titles(one)).toEqual(['a']);
  });
});
