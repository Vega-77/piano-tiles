import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudError, describeCloudError } from './errors';

afterEach(() => vi.unstubAllGlobals());

describe('words for what went wrong', () => {
  it('says nothing when the player only closed the sign-in window', () => {
    for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']) {
      expect(describeCloudError({ code })).toBeUndefined();
    }
  });

  it('explains the setup problems the owner can fix', () => {
    expect(describeCloudError({ code: 'permission-denied' })).toMatch(/rules/);
    expect(describeCloudError({ code: 'auth/unauthorized-domain' })).toMatch(/Authorized domains/);
    expect(describeCloudError({ code: 'auth/operation-not-allowed' })).toMatch(/Google sign-in/);
    expect(describeCloudError({ code: 'auth/popup-blocked' })).toMatch(/pop-ups/);
  });

  it('explains the free limit', () => {
    expect(describeCloudError({ code: 'resource-exhausted' })).toMatch(/free limit/);
  });

  it('takes a lost connection as one however it is reported', () => {
    const lost = describeCloudError({ code: 'unavailable' });
    expect(lost).toMatch(/Couldn't reach the cloud/);
    expect(describeCloudError({ code: 'firestore/unavailable' })).toBe(lost);
    expect(describeCloudError({ code: 'auth/network-request-failed' })).toBe(lost);
    expect(describeCloudError({ code: 'deadline-exceeded' })).toBe(lost);
  });

  it('passes on what a CloudError says', () => {
    expect(describeCloudError(new CloudError('A song is incomplete.'))).toBe('A song is incomplete.');
  });

  it('blames the connection for an unknown failure while offline, and is vague otherwise', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(describeCloudError(new Error('x'))).toMatch(/Couldn't reach the cloud/);
    vi.stubGlobal('navigator', { onLine: true });
    expect(describeCloudError(new Error('x'))).toMatch(/Something went wrong/);
    expect(describeCloudError(undefined)).toMatch(/Something went wrong/);
  });
});
