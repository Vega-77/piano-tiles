import { describe, expect, it } from 'vitest';
import { eventAge } from './input';
import { listenToTrace, signedMs, trace, tracing } from './trace';

describe('eventAge', () => {
  it('is how long ago the event happened, in seconds', () => {
    expect(eventAge({ timeStamp: 900 }, 1000)).toBeCloseTo(0.1, 9);
    expect(eventAge({ timeStamp: 1000 }, 1000)).toBe(0);
  });

  it('is nothing for a time that is from the future', () => {
    expect(eventAge({ timeStamp: 1010 }, 1000)).toBe(0);
  });

  it('is nothing for a time that is not on the page clock, or so old that something else is wrong', () => {
    expect(eventAge({ timeStamp: Date.now() }, 1000)).toBe(0); // (some browsers stamp with the epoch)
    expect(eventAge({ timeStamp: 1000 - 301 }, 1000)).toBe(0);
    expect(eventAge({ timeStamp: 1000 - 299 }, 1000)).toBeCloseTo(0.299, 9);
  });
});

describe('trace', () => {
  it('hands each line to the listener, and builds none when nobody listens', () => {
    let built = 0;
    const line = () => {
      built++;
      return 'hello';
    };
    expect(tracing()).toBe(false);
    trace(line);
    expect(built).toBe(0);

    const heard: string[] = [];
    listenToTrace((text) => heard.push(text));
    expect(tracing()).toBe(true);
    trace(line);
    expect(heard).toEqual(['hello']);
    expect(built).toBe(1);

    listenToTrace(null);
    trace(line);
    expect(heard).toHaveLength(1);
    expect(built).toBe(1);
  });

  it('writes a time with its sign', () => {
    expect(signedMs(0.008)).toBe('+8ms');
    expect(signedMs(-0.12)).toBe('−120ms');
    expect(signedMs(0)).toBe('+0ms');
  });
});
