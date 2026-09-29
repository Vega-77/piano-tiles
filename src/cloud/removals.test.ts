import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalRemovals, createMemoryRemovals, type RemovalLog } from './removals';

function behavesLikeALog(make: () => RemovalLog) {
  it('remembers when a song was removed, and forgets it on request', () => {
    const log = make();
    log.add('a', 10);
    log.add('b', 20);
    log.add('a', 30);
    expect([...log.all()]).toEqual([
      ['a', 30],
      ['b', 20],
    ]);
    log.drop('a');
    expect([...log.all()]).toEqual([['b', 20]]);
    log.drop('nothing');
    expect(log.all().size).toBe(1);
  });
}

describe('the removal log in memory', () => {
  behavesLikeALog(createMemoryRemovals);

  it('hands out a copy', () => {
    const log = createMemoryRemovals();
    log.add('a', 1);
    (log.all() as Map<string, number>).clear();
    expect(log.all().size).toBe(1);
  });
});

describe('the removal log in this browser', () => {
  beforeEach(() => localStorage.clear());
  behavesLikeALog(createLocalRemovals);

  it('is still there for another log made afterwards (a reload)', () => {
    createLocalRemovals().add('a', 5);
    expect([...createLocalRemovals().all()]).toEqual([['a', 5]]);
  });

  it('keeps only the newest 200', () => {
    const log = createLocalRemovals();
    for (let i = 0; i < 250; i++) log.add(`song-${i}`, i);
    const kept = log.all();
    expect(kept.size).toBe(200);
    expect(kept.has('song-249')).toBe(true);
    expect(kept.has('song-49')).toBe(false);
  });

  it('starts empty when what is stored is not a log', () => {
    localStorage.setItem('piano-tiles-removed', '{"nope":1}');
    expect(createLocalRemovals().all().size).toBe(0);
    localStorage.setItem('piano-tiles-removed', 'not json');
    expect(createLocalRemovals().all().size).toBe(0);
    localStorage.setItem('piano-tiles-removed', JSON.stringify([['a', 1], ['b'], 'c', [3, 4]]));
    expect([...createLocalRemovals().all()]).toEqual([['a', 1]]);
  });

  it('carries on quietly where storage is not allowed', () => {
    const log = createLocalRemovals();
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => log.add('a', 1)).not.toThrow();
    blocked.mockRestore();
  });
});
