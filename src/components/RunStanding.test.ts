import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBackend, type FakeBackend } from '../cloud/testing';
import { mount, settle, submitForm, typeInto, type Mounted } from '../hooks/testing';
import { useCloud } from '../hooks/useCloud';
import { RunStanding } from './RunStanding';

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

/** The run's result screen, as the game shows it, over a backend where everyone starts as a stranger. */
async function show(backend: FakeBackend, run = { score: 300, laps: 2, chain: 9 }) {
  const Harness = () => createElement(RunStanding, { songId: 'a', run, cloud: useCloud({ backend }) });
  shown = await mount(createElement(Harness));
  return shown.container;
}

const field = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input#nickname');
const form = (container: HTMLElement) => container.querySelector('form')!;

describe('after a run', () => {
  it('asks a stranger for a nickname and sends nothing yet', async () => {
    const backend = createFakeBackend();
    const container = await show(backend);

    expect(field(container)).not.toBeNull();
    expect(container.textContent).toContain('Sign in with Google');
    expect(backend.leaderboards.calls).toEqual([]);
    expect(backend.guests).toBe(0);
  });

  it('makes a guest of them once they choose a nickname, and puts the run on the board', async () => {
    const backend = createFakeBackend();
    const container = await show(backend);

    await typeInto(field(container)!, 'Pat');
    await submitForm(form(container));

    expect(backend.people.names.get('guest-1')).toBe('Pat');
    expect(backend.leaderboards.boards.get('a')?.get('guest-1')).toMatchObject({ name: 'Pat', score: 300, laps: 2, chain: 9 });
    expect(container.textContent).toContain('New best on the leaderboard');
    expect(container.textContent).toContain('#1');
    expect(container.querySelector('ol[aria-label="Leaderboard"]')?.textContent).toContain('Pat');
    expect(field(container)).toBeNull();
  });

  it('says a nickname is taken, keeps the form, and sends nothing', async () => {
    const backend = createFakeBackend();
    backend.people.owners.set('pat', 'somebody');
    const container = await show(backend);

    await typeInto(field(container)!, 'pat');
    await submitForm(form(container));

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/taken/);
    expect(field(container)).not.toBeNull();
    expect(backend.leaderboards.calls).toEqual([]);

    // (A different name works from the same form.)
    await typeInto(field(container)!, 'pat2');
    await submitForm(form(container));
    expect(backend.leaderboards.boards.get('a')?.get('guest-1')?.name).toBe('pat2');
  });

  it('does not ask for a nickname twice: a player who has one is put on the board at once, once', async () => {
    const backend = createFakeBackend();
    backend.account = { uid: 'guest-7', name: 'Guest', guest: true };
    backend.people.names.set('guest-7', 'Sam');
    const container = await show(backend);

    expect(field(container)).toBeNull();
    expect(backend.leaderboards.calls.filter((call) => call.startsWith('submit'))).toEqual(['submit a 300']);
    expect(container.textContent).toContain('New best on the leaderboard');
  });

  it('says the best stays when the run did not beat it', async () => {
    const backend = createFakeBackend();
    backend.account = { uid: 'guest-7', name: 'Guest', guest: true };
    backend.people.names.set('guest-7', 'Sam');
    backend.leaderboards.boards.set('a', new Map([['guest-7', { uid: 'guest-7', name: 'Sam', score: 900, laps: 3, chain: 20 }]]));

    const container = await show(backend);

    expect(container.textContent).toContain('Your best on the leaderboard stays');
    expect(container.textContent).toContain('900');
  });

  it('offers to send the score again when the cloud could not be reached', async () => {
    const backend = createFakeBackend();
    backend.account = { uid: 'guest-7', name: 'Guest', guest: true };
    backend.people.names.set('guest-7', 'Sam');
    backend.leaderboards.offline = true;
    const container = await show(backend);

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/reach the cloud/);

    backend.leaderboards.offline = false;
    const again = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Send the score again')!;
    await settle(() => again.click());

    expect(container.textContent).toContain('New best on the leaderboard');
    expect(backend.leaderboards.boards.get('a')?.get('guest-7')?.score).toBe(300);
  });
});
