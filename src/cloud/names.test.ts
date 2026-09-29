import { describe, expect, it } from 'vitest';
import { CloudError } from './errors';
import { NAME_MAX, NAME_MIN, nameKey, parseName } from './names';

describe('a player’s name', () => {
  it('is what was typed, without the space round it', () => {
    expect(parseName('  Pat_99-x ')).toBe('Pat_99-x');
  });

  it('has a length to keep to', () => {
    expect(parseName('a'.repeat(NAME_MIN))).toHaveLength(NAME_MIN);
    expect(parseName('a'.repeat(NAME_MAX))).toHaveLength(NAME_MAX);
    expect(() => parseName('a'.repeat(NAME_MIN - 1))).toThrow(CloudError);
    expect(() => parseName('a'.repeat(NAME_MAX + 1))).toThrow(CloudError);
    expect(() => parseName('   ')).toThrow(CloudError);
  });

  it('has only letters, numbers, dashes and underscores', () => {
    for (const bad of ['two words', 'dot.dot', 'emoji😀😀', 'ünïcode', 'a/b/c', 'semi;colon']) {
      expect(() => parseName(bad)).toThrow(/letters, numbers/);
    }
  });

  it('is compared in lower case', () => {
    expect(nameKey('PatTy')).toBe('patty');
    expect(nameKey('PATTY')).toBe(nameKey('patty'));
  });
});
