/** A little way to run a hook or a component in a test (nothing here is used by the app). */
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  unmount(): Promise<void>;
}

/** Puts `element` on a page of its own, letting whatever it starts settle before this resolves. */
export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

export interface Rendered<T> extends Mounted {
  /** What the hook returned the last time it ran. */
  result: { current: T };
}

/** Runs `hook` in a component, letting whatever it starts settle before this resolves. */
export async function renderHook<T>(hook: () => T): Promise<Rendered<T>> {
  const result = { current: undefined as T };
  const Probe = () => {
    result.current = hook();
    return null;
  };
  return { result, ...(await mount(createElement(Probe))) };
}

/** Runs `work` and lets whatever it sets going settle, resolving with what it resolved with. */
export async function settle<T>(work: () => Promise<T> | T): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await work();
  });
  return out;
}

/** Types into a field the way a person does, so the component hears about it. */
export function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  return settle(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Submits the form the way pressing its button does. */
export function submitForm(form: HTMLFormElement): Promise<void> {
  return settle(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
