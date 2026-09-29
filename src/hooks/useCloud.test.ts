import { describe, expect, it } from 'vitest';
import { createFakeBackend } from '../cloud/testing';
import { CloudError } from '../cloud/errors';
import { renderHook, settle } from './testing';
import { useCloud } from './useCloud';

async function setup(prepare?: (backend: ReturnType<typeof createFakeBackend>) => void) {
  const backend = createFakeBackend();
  prepare?.(backend);
  const view = await renderHook(() => useCloud({ backend }));
  return { backend, ...view };
}

describe('who is playing', () => {
  it('starts with nobody, having started loading the cloud but signed nobody in', async () => {
    const { backend, result } = await setup();
    expect(result.current).toMatchObject({ account: null, nickname: undefined, admin: false, checking: false });
    expect(backend.warmed).toBe(1);
    expect(backend.guests).toBe(0);
  });

  it('finds the nickname of whoever is already signed in', async () => {
    const { result } = await setup((backend) => {
      backend.account = { uid: 'guest-9', name: 'Guest', guest: true };
      backend.people.names.set('guest-9', 'Pat');
    });
    expect(result.current.account?.uid).toBe('guest-9');
    expect(result.current.nickname).toBe('Pat');
  });

  it('knows a signed-in nobody-in-particular has no nickname yet', async () => {
    const { result } = await setup((backend) => {
      backend.account = { uid: 'guest-9', name: 'Guest', guest: true };
    });
    expect(result.current.nickname).toBeNull();
  });

  it('finds out whether a Google account is an admin, and never asks for a guest', async () => {
    const admin = await setup((backend) => {
      backend.account = { uid: 'g1', name: 'Pat', guest: false };
      backend.people.admins.add('g1');
    });
    expect(admin.result.current.admin).toBe(true);

    const plain = await setup((backend) => {
      backend.account = { uid: 'g2', name: 'Sam', guest: false };
    });
    expect(plain.result.current.admin).toBe(false);

    const guest = await setup((backend) => {
      backend.account = { uid: 'guest-1', name: 'Guest', guest: true };
      backend.people.admins.add('guest-1');
    });
    expect(guest.result.current.admin).toBe(false);
    expect(guest.backend.people.calls).not.toContain('isAdmin guest-1');
  });

  it('stops listening when the page goes', async () => {
    const { backend, unmount } = await setup();
    await unmount();
    backend.account = { uid: 'late', name: 'Late', guest: true };
    await settle(() => window.dispatchEvent(new Event('online')));
    expect(backend.guests).toBe(0);
  });
});

describe('taking a nickname', () => {
  it('makes a guest account for the player and gives the nickname to it', async () => {
    const { backend, result } = await setup();

    const problem = await settle(() => result.current.claimName(' Pat '));

    expect(problem).toBeNull();
    expect(backend.guests).toBe(1);
    expect(result.current.account).toMatchObject({ uid: 'guest-1', guest: true });
    expect(result.current.nickname).toBe('Pat');
    expect(backend.people.names.get('guest-1')).toBe('Pat');
  });

  it('says what is wrong with a name without making an account for it', async () => {
    const { backend, result } = await setup();

    expect(await settle(() => result.current.claimName('a b'))).toMatch(/letters, numbers/);
    expect(await settle(() => result.current.claimName('ab'))).toMatch(/3 to 16/);
    expect(backend.guests).toBe(0);
    expect(result.current.account).toBeNull();
  });

  it('refuses a name somebody has, whatever its capitals, and leaves the player without one', async () => {
    const { backend, result } = await setup((backend) => backend.people.owners.set('pat', 'somebody'));

    const problem = await settle(() => result.current.claimName('PAT'));

    expect(problem).toMatch(/taken/);
    expect(result.current.nickname).toBeNull();
    expect(backend.people.names.size).toBe(0);
    // (Another try, with another name, works with the guest account already made.)
    expect(await settle(() => result.current.claimName('Pat2'))).toBeNull();
    expect(backend.guests).toBe(1);
    expect(result.current.nickname).toBe('Pat2');
  });

  it('says so, in words, when the cloud cannot be reached', async () => {
    const { backend, result } = await setup();
    backend.failSignIn = Object.assign(new Error('offline'), { code: 'auth/network-request-failed' });

    expect(await settle(() => result.current.claimName('Pat'))).toMatch(/reach the cloud/);
    expect(result.current.nickname).toBeNull();
  });
});

describe('signing in with Google', () => {
  it('keeps the guest’s account, and so the nickname and the scores, when they sign in', async () => {
    const { backend, result } = await setup();
    await settle(() => result.current.claimName('Pat'));

    await settle(() => result.current.signInWithGoogle());

    expect(result.current.account).toMatchObject({ uid: 'guest-1', name: 'Pat', guest: false });
    expect(result.current.nickname).toBe('Pat');
    expect(backend.people.names.get('guest-1')).toBe('Pat');
    expect(result.current.signingIn).toBe(false);
  });

  it('tells the player when the sign-in window was blocked, and lets them dismiss it', async () => {
    const { backend, result } = await setup();
    backend.failSignIn = Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' });

    await settle(() => result.current.signInWithGoogle());
    expect(result.current.error).toMatch(/pop-ups/);
    expect(result.current.account).toBeNull();

    await settle(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });

  it('says nothing when the player closed the window themselves', async () => {
    const { backend, result } = await setup();
    backend.failSignIn = Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' });
    await settle(() => result.current.signInWithGoogle());
    expect(result.current.error).toBeNull();
  });

  it('forgets who was signed in when they sign out', async () => {
    const { result } = await setup((backend) => {
      backend.account = { uid: 'g1', name: 'Pat', guest: false };
      backend.people.names.set('g1', 'Pat');
      backend.people.admins.add('g1');
    });
    expect(result.current).toMatchObject({ nickname: 'Pat', admin: true });

    await settle(() => result.current.signOut());

    expect(result.current).toMatchObject({ account: null, nickname: undefined, admin: false });
  });
});

describe('the leaderboard', () => {
  it('will not take a run from somebody with no nickname', async () => {
    const { result } = await setup();
    await expect(settle(() => result.current.submit('a', { score: 100, laps: 1, chain: 3 }))).rejects.toBeInstanceOf(CloudError);
  });

  it('puts a run on the board under the nickname and says where it stands', async () => {
    const { backend, result } = await setup();
    await settle(() => result.current.claimName('Pat'));

    const sent = await settle(() => result.current.submit('a', { score: 300.4, laps: 2, chain: 7 }));

    expect(sent.improved).toBe(true);
    expect(sent.mine).toMatchObject({ rank: 1, score: { name: 'Pat', score: 300, laps: 2, chain: 7 } });
    expect(sent.top).toHaveLength(1);
    expect(backend.leaderboards.boards.get('a')?.get('guest-1')).toMatchObject({ name: 'Pat', score: 300 });
  });

  it('keeps the best run, so a worse one changes nothing', async () => {
    const { backend, result } = await setup();
    await settle(() => result.current.claimName('Pat'));
    await settle(() => result.current.submit('a', { score: 500, laps: 2, chain: 7 }));

    const worse = await settle(() => result.current.submit('a', { score: 200, laps: 1, chain: 2 }));

    expect(worse.improved).toBe(false);
    expect(worse.mine?.score.score).toBe(500);
    expect(backend.leaderboards.boards.get('a')?.get('guest-1')?.score).toBe(500);
  });

  it('shows the others on the board too, best first', async () => {
    const { backend, result } = await setup();
    backend.leaderboards.boards.set(
      'a',
      new Map([
        ['x', { uid: 'x', name: 'Xan', score: 900, laps: 3, chain: 20 }],
        ['y', { uid: 'y', name: 'Yas', score: 100, laps: 1, chain: 4 }],
      ]),
    );
    await settle(() => result.current.claimName('Pat'));

    const sent = await settle(() => result.current.submit('a', { score: 400, laps: 2, chain: 8 }));

    expect(sent.top.map((score) => score.name)).toEqual(['Xan', 'Pat', 'Yas']);
    expect(sent.mine?.rank).toBe(2);
  });

  it('looks at a board again only when it is a while since, or asked to', async () => {
    const { backend, result } = await setup();
    const tops = () => backend.leaderboards.calls.filter((call) => call.startsWith('top')).length;

    await settle(() => result.current.loadBoard('a'));
    await settle(() => result.current.loadBoard('a'));
    expect(tops()).toBe(1);

    await settle(() => result.current.loadBoard('a', true));
    expect(tops()).toBe(2);
    await settle(() => result.current.loadBoard('b'));
    expect(tops()).toBe(3);
  });

  it('has no standing to show for somebody who has not signed in', async () => {
    const { backend, result } = await setup();
    const board = await settle(() => result.current.loadBoard('a'));
    expect(board.mine).toBeUndefined();
    expect(backend.leaderboards.calls.some((call) => call.startsWith('standing'))).toBe(false);
  });

  it('rejects, so the run can be sent again, when the cloud cannot be reached', async () => {
    const { backend, result } = await setup();
    await settle(() => result.current.claimName('Pat'));
    backend.leaderboards.offline = true;

    await expect(settle(() => result.current.submit('a', { score: 100, laps: 1, chain: 1 }))).rejects.toMatchObject({ code: 'unavailable' });

    backend.leaderboards.offline = false;
    expect((await settle(() => result.current.submit('a', { score: 100, laps: 1, chain: 1 }))).improved).toBe(true);
  });
});
