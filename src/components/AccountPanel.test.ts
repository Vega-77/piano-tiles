import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, type Mounted } from '../hooks/testing';
import { AccountPanel } from './AccountPanel';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

type Cloud = Parameters<typeof AccountPanel>[0]['cloud'];

async function show(overrides: Partial<Cloud>) {
  const cloud: Cloud = {
    account: null,
    nickname: undefined,
    admin: false,
    checking: false,
    signingIn: false,
    error: null,
    signInWithGoogle: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    dismissError: vi.fn(),
    ...overrides,
  };
  shown = await mount(createElement(AccountPanel, { cloud }));
  return { cloud, container: shown.container };
}

const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);

describe('who is playing, under the title', () => {
  it('offers a way back in to somebody who is not signed in', async () => {
    const { cloud, container } = await show({});
    await settle(() => button(container, 'Sign in with Google')!.click());
    expect(cloud.signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('says nothing while it is still finding out who is signed in', async () => {
    const { container } = await show({ checking: true });
    expect(container.textContent).toBe('');
  });

  it('shows a guest by their nickname and offers to keep it with Google', async () => {
    const { cloud, container } = await show({ account: { uid: 'g', name: 'Guest', guest: true }, nickname: 'Pat' });
    expect(container.textContent).toContain('Playing as Pat');
    expect(button(container, 'Sign out')).toBeUndefined();
    await settle(() => button(container, 'Keep it with Google')!.click());
    expect(cloud.signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('lets a Google account sign out, and shows its id until it is made an admin', async () => {
    const account = { uid: 'the-account-id', name: 'Pat', guest: false };
    const { cloud, container } = await show({ account, nickname: 'Pat' });
    expect(container.querySelector('details code')?.textContent).toBe('the-account-id');
    await settle(() => button(container, 'Sign out')!.click());
    expect(cloud.signOut).toHaveBeenCalledTimes(1);

    await shown!.unmount();
    const admin = await show({ account, nickname: 'Pat', admin: true });
    expect(admin.container.textContent).toContain('Admin');
    expect(admin.container.querySelector('details')).toBeNull();
  });

  it('shows what went wrong, until it is dismissed', async () => {
    const { cloud, container } = await show({ error: 'Your browser blocked the sign-in window.' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blocked');
    await settle(() => button(container, 'OK')!.click());
    expect(cloud.dismissError).toHaveBeenCalledTimes(1);
  });
});
