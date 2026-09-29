import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './audio';

/**
 * A stand-in for the parts of Web Audio the recording playback touches. It keeps the browser's
 * own rules, which the engine tests' fake `Sound` never sees: a source can't be stopped before it
 * has been started, and can't be started twice.
 */
class FakeParam {
  value = 0;
  readonly events: Array<{ kind: 'set' | 'ramp'; value: number; at: number }> = [];
  setValueAtTime(value: number, at: number) {
    this.events.push({ kind: 'set', value, at });
    return this;
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push({ kind: 'ramp', value, at });
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  connect<T>(next: T): T {
    return next;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  readonly playbackRate = new FakeParam();
  startedAt: { when: number; from: number } | null = null;
  stoppedAt: number[] = [];
  start(when: number, from: number) {
    if (this.startedAt) throw new DOMException('cannot call start more than once', 'InvalidStateError');
    this.startedAt = { when, from };
  }
  stop(when: number) {
    if (!this.startedAt) throw new DOMException('cannot call stop without calling start first', 'InvalidStateError');
    this.stoppedAt.push(when);
  }
}

class FakeContext {
  static last: FakeContext;
  currentTime = 10;
  state = 'running';
  baseLatency = 0;
  outputLatency = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  constructor() {
    FakeContext.last = this;
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 120 });
  }
  resume() {
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
}

const URL = 'song.mp3';

async function ready() {
  const engine = new AudioEngine({ read: async () => new ArrayBuffer(8) });
  engine.unlock();
  engine.startSong();
  await engine.load(URL);
  return { engine, ctx: FakeContext.last };
}

beforeEach(() => vi.stubGlobal('AudioContext', FakeContext));
afterEach(() => vi.unstubAllGlobals());

describe('playing a recording', () => {
  it('starts a recording that is cut short before it schedules its stop', async () => {
    const { engine, ctx } = await ready();
    expect(() => engine.playRecording(URL, 11, 1, { end: 75 })).not.toThrow();
    const [source] = ctx.sources;
    expect(source.startedAt).toEqual({ when: 11, from: 0 });
    // Stopped just after the end, once it has faded out.
    expect(source.stoppedAt).toEqual([11 + 75 + 0.02]);
  });

  it('ends sooner in the clock when it is played faster', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1.5, { end: 60 });
    expect(ctx.sources[0].stoppedAt).toEqual([11 + 40 + 0.02]);
  });

  it('fades out into the cut instead of stopping dead', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1, { end: 75 });
    const voice = ctx.gains[ctx.gains.length - 1];
    expect(voice.gain.events).toEqual([
      { kind: 'set', value: 1, at: 11 + 75 - 0.3 },
      { kind: 'ramp', value: 0, at: 11 + 75 },
    ]);
  });

  it('plays a song without a cut out to its own end, with no stop scheduled', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1);
    expect(ctx.sources[0].startedAt).toEqual({ when: 11, from: 0 });
    expect(ctx.sources[0].stoppedAt).toEqual([]);
  });

  it('skips into the recording when the count-in holds it back', async () => {
    const { engine, ctx } = await ready();
    // Wanted at song time 11 but not to be heard before 12.5: it joins 1.5 s in, at the speed it is going.
    engine.playRecording(URL, 11, 2, { notBefore: 12.5, end: 60 });
    expect(ctx.sources[0].startedAt).toEqual({ when: 12.5, from: 3 });
  });

  it('plays nothing when the cut has already passed', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 0, 1, { end: 5 }); // it would have stopped at 5 s; the clock is at 10
    expect(ctx.sources).toHaveLength(0);
  });

  it('fades the last lap out as the next one comes in, including one that was cut short', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1, { end: 75 });
    ctx.currentTime = 80;
    expect(() => engine.playRecording(URL, 82, 1.2, { end: 75 })).not.toThrow();
    const [first, second] = ctx.sources;
    // The first lap is still playing at 82 (it ends at 86), so it gives way.
    expect(first.stoppedAt[first.stoppedAt.length - 1]).toBeCloseTo(82.04, 9);
    expect(second.startedAt?.when).toBe(82);
  });

  it('leaves a lap that has already ended alone when the next one starts', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1, { end: 20 }); // over at 31
    ctx.currentTime = 40;
    engine.playRecording(URL, 42, 1.2, { end: 20 });
    expect(ctx.sources[0].stoppedAt).toEqual([31.02]);
  });

  it('can be silenced and started again in the middle of a lap', async () => {
    const { engine, ctx } = await ready();
    engine.playRecording(URL, 11, 1, { end: 75 });
    ctx.currentTime = 20;
    engine.silence();
    expect(ctx.sources[0].stoppedAt).toContain(20);
    expect(() => engine.playRecording(URL, 11, 1, { end: 75, notBefore: 24 })).not.toThrow();
    expect(ctx.sources[1].startedAt).toEqual({ when: 24, from: 13 });
  });
});
