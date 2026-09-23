import { describe, expect, it, vi } from 'vitest';
import { FIRST_SIGHT_OPTIONS, observeFirstSight } from './firstSight';

/**
 * R127: a block's exposure counts when it is first SEEN. The trigger must not
 * depend on the block's own height — a taller arm must not be "seen" sooner —
 * so it is its TOP EDGE entering the upper 75% of the viewport:
 * threshold 0 with the viewport's bottom quarter cut off.
 */

class FakeObserver {
  static made: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public callback: (entries: Array<{ isIntersecting: boolean }>) => void, public options: IntersectionObserverInit) {
    FakeObserver.made.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  fire(isIntersecting: boolean) { this.callback([{ isIntersecting }]); }
}

const el = {} as Element;

describe('observeFirstSight', () => {
  it('uses one observer per block, with a height-independent trigger', () => {
    FakeObserver.made = [];
    observeFirstSight(el, () => {}, FakeObserver as never);
    expect(FakeObserver.made).toHaveLength(1);
    expect(FakeObserver.made[0]!.observed).toEqual([el]);
    expect(FakeObserver.made[0]!.options).toEqual(FIRST_SIGHT_OPTIONS);
    expect(FIRST_SIGHT_OPTIONS).toEqual({ threshold: 0, rootMargin: '0px 0px -25% 0px' });
  });

  it('reports the first sighting once, then disconnects', () => {
    FakeObserver.made = [];
    const onSeen = vi.fn();
    observeFirstSight(el, onSeen, FakeObserver as never);
    const o = FakeObserver.made[0]!;
    o.fire(false);
    expect(onSeen).not.toHaveBeenCalled();
    o.fire(true);
    o.fire(true);
    expect(onSeen).toHaveBeenCalledTimes(1);
    expect(o.disconnected).toBe(true);
  });

  it('stops observing when the block unmounts first', () => {
    FakeObserver.made = [];
    const onSeen = vi.fn();
    const stop = observeFirstSight(el, onSeen, FakeObserver as never);
    stop();
    expect(FakeObserver.made[0]!.disconnected).toBe(true);
    FakeObserver.made[0]!.fire(true);
    expect(onSeen).not.toHaveBeenCalled();
  });

  it('without IntersectionObserver, the block counts as seen at mount', () => {
    const onSeen = vi.fn();
    observeFirstSight(el, onSeen, undefined);
    expect(onSeen).toHaveBeenCalledTimes(1);
  });
});

describe('checkPendingSightings — the page is leaving before the observer reported (R126 × R127)', () => {
  /**
   * An observer's callback waits for a rendering step, which a busy main
   * thread delays by seconds (measured: blocks observed 1–2 s after paint, the
   * visitor gone before the callback). On pagehide the same trigger is read
   * from geometry, synchronously, so a block the visitor had in view counts.
   */
  function block(top: number, height = 200) {
    return { getBoundingClientRect: () => ({ top, bottom: top + height, height, width: 300 }) } as unknown as Element;
  }
  const viewport = { innerHeight: 800 };

  it('reports a block whose top edge is in the upper 75% of the viewport; leaves the others pending', async () => {
    const { observeFirstSight: observe, checkPendingSightings } = await import('./firstSight');
    FakeObserver.made = [];
    const top = vi.fn();
    const below = vi.fn();
    const scrolledPast = vi.fn();
    observe(block(100), top, FakeObserver as never);
    observe(block(700), below, FakeObserver as never);   // 700 > 600: not yet
    observe(block(-500, 300), scrolledPast, FakeObserver as never); // entirely above: not in view
    checkPendingSightings(viewport);
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(scrolledPast).not.toHaveBeenCalled();
    // Reported once: neither a second check nor the observer's late callback reports it again.
    checkPendingSightings(viewport);
    FakeObserver.made[0]!.fire(true);
    expect(top).toHaveBeenCalledTimes(1);
    expect(FakeObserver.made[0]!.disconnected).toBe(true);
  });

  it('forgets a block that unmounted', async () => {
    const { observeFirstSight: observe, checkPendingSightings } = await import('./firstSight');
    const onSeen = vi.fn();
    const stop = observe(block(10), onSeen, FakeObserver as never);
    stop();
    checkPendingSightings(viewport);
    expect(onSeen).not.toHaveBeenCalled();
  });
});
