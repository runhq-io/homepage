import { afterEach, describe, expect, it, vi } from 'vitest';

/** The SDK's insertion point: after the first paint, then (by default) idle time. */
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browser() {
  const frames: Array<() => void> = [];
  const tasks: Array<() => void> = [];
  const idles: Array<{ fn: () => void; timeout?: number }> = [];
  vi.stubGlobal('window', {
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return 1; },
    setTimeout: (fn: () => void) => { tasks.push(fn); return 1; },
    requestIdleCallback: (fn: () => void, o?: { timeout: number }) => { idles.push({ fn, timeout: o?.timeout }); return 1; },
  });
  return { frames, tasks, idles };
}

describe('afterFirstPaint', () => {
  it('runs after the next paint (a task queued from a frame), then when idle', async () => {
    const b = browser();
    const { afterFirstPaint } = await import('./afterFirstPaint');
    const fn = vi.fn();
    afterFirstPaint(fn);
    b.frames.splice(0).forEach((f) => f());
    b.tasks.splice(0).forEach((f) => f());
    expect(fn).not.toHaveBeenCalled();
    expect(b.idles[0]!.timeout).toBe(1000);
    b.idles[0]!.fn();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('with idle: false, runs right after the paint', async () => {
    const b = browser();
    const { afterFirstPaint } = await import('./afterFirstPaint');
    const fn = vi.fn();
    afterFirstPaint(fn, { idle: false });
    expect(fn).not.toHaveBeenCalled();
    b.frames.splice(0).forEach((f) => f());
    expect(fn).not.toHaveBeenCalled();
    b.tasks.splice(0).forEach((f) => f());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.idles).toHaveLength(0);
  });
});
