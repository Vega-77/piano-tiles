// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import {
  MISSING_AUDIO,
  createIndexedDbStore,
  createMemoryStore,
  friendly,
  readStoredAudio,
  storedFolder,
  storedId,
  type SongStore,
} from './store';
import { fakeChart } from './testing';

const audio = (text: string) => new Blob([text], { type: 'audio/mpeg' });

/** The same checks for both kinds of store: what one keeps, the other must keep. */
function behavesLikeAStore(name: string, make: () => SongStore) {
  describe(name, () => {
    it('starts empty', async () => {
      const store = make();
      expect(await store.charts()).toEqual([]);
      expect(await store.chart('demo')).toBeUndefined();
      expect(await store.audio('demo')).toBeUndefined();
    });

    it('keeps a song: its chart, and its audio byte for byte', async () => {
      const store = make();
      await store.save(fakeChart('demo'), audio('sound of music'));
      expect(await store.chart('demo')).toEqual(fakeChart('demo'));
      expect(await store.charts()).toEqual([fakeChart('demo')]);
      const kept = await store.audio('demo');
      expect(await kept!.text()).toBe('sound of music');
    });

    it('changes a chart and leaves the audio where it is', async () => {
      const store = make();
      await store.save(fakeChart('demo'), audio('sound'));
      await store.save(fakeChart('demo', { title: 'Renamed' }));
      expect(((await store.chart('demo')) as { title: string }).title).toBe('Renamed');
      expect(await (await store.audio('demo'))!.text()).toBe('sound');
    });

    it('keeps songs apart and removes one without touching the rest', async () => {
      const store = make();
      await store.save(fakeChart('one'), audio('1'));
      await store.save(fakeChart('two'), audio('2'));
      await store.remove('one');
      expect((await store.charts()).map((c) => (c as { id: string }).id)).toEqual(['two']);
      expect(await store.audio('one')).toBeUndefined();
      expect(await (await store.audio('two'))!.text()).toBe('2');
    });

    it('can remove a song that is not there', async () => {
      await expect(make().remove('nothing')).resolves.toBeUndefined();
    });
  });
}

behavesLikeAStore('the in-memory store', () => createMemoryStore());
behavesLikeAStore('the IndexedDB store', () => createIndexedDbStore(new IDBFactory()));

describe('the IndexedDB store', () => {
  it('is still there when the page opens the database again', async () => {
    const factory = new IDBFactory();
    await createIndexedDbStore(factory).save(fakeChart('demo'), audio('sound'));
    const again = createIndexedDbStore(factory);
    expect((await again.charts()).length).toBe(1);
    expect(await (await again.audio('demo'))!.text()).toBe('sound');
  });

  it('says it keeps songs, and the memory store says it does not', () => {
    expect(createIndexedDbStore(new IDBFactory()).persistent).toBe(true);
    expect(createMemoryStore().persistent).toBe(false);
  });

  it('fails, rather than hangs, when the browser will not open a database', async () => {
    const refusing = {
      open() {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          Object.defineProperty(request, 'error', { value: new DOMException('denied', 'SecurityError') });
          request.onerror?.(new Event('error'));
        });
        return request;
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbStore(refusing).charts()).rejects.toThrow('denied');
  });
});

describe('words for a failed save', () => {
  it('says when the device is full', () => {
    const full = friendly(new DOMException('full', 'QuotaExceededError'));
    expect(full).toBeInstanceOf(ImportError);
    expect(full.message).toMatch(/no room/);
  });

  it('says something useful for anything else', () => {
    expect(friendly(new Error('boom')).message).toMatch(/private window/);
  });
});

describe('finding a stored song\'s audio', () => {
  it('names the folder the game will ask about', () => {
    expect(storedFolder('my-song')).toBe('stored:my-song/');
    expect(storedId('stored:my-song/audio-1.mp3')).toBe('my-song');
    expect(storedId('https://example.test/songs/x/audio.mp3')).toBeUndefined();
    expect(storedId('stored:../evil/a.mp3')).toBeUndefined();
  });

  it('reads the bytes of a stored song', async () => {
    const store = createMemoryStore();
    await store.save(fakeChart('demo'), audio('abc'));
    const bytes = await readStoredAudio('stored:demo/audio-00000000.mp3', async () => store);
    expect(new TextDecoder().decode(bytes)).toBe('abc');
  });

  it('leaves other URLs to the network, without opening the store', async () => {
    const never = async (): Promise<SongStore> => {
      throw new Error('should not be opened');
    };
    expect(await readStoredAudio('https://example.test/a.mp3', never)).toBeUndefined();
  });

  it('says so when a stored song has lost its audio', async () => {
    const store = createMemoryStore();
    await store.save(fakeChart('demo'));
    await expect(readStoredAudio('stored:demo/audio-00000000.mp3', async () => store)).rejects.toThrow(MISSING_AUDIO);
  });
});
