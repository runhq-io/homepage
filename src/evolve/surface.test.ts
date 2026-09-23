import { describe, expect, it, vi } from 'vitest';
import { createSurfaceStore, mergeFields, SURFACE_WAIT_MS, type SurfaceEnv } from './surface';
import { parseServingConfig, type EvolveBootHandle, type RenderEntry, type ServingConfig } from './bootConfig';
import { evolveAssign } from './evolveAssign.js';

/**
 * R114: the copy is decided SYNCHRONOUSLY from the boot config — never by
 * waiting for the SDK. No consent ⇒ the adopted copy (else shipped), no arm,
 * nothing recorded. Consent + an id ⇒ the arm, painted at once, its exposure
 * queued for the SDK. A config still in flight at first render is waited for
 * (invisibly) up to SURFACE_WAIT_MS, judged by when it ARRIVED, not by a timer;
 * past that the shipped copy paints and never swaps.
 */

const HERO = { heroH1Line1: 'Signal-to-code.', ctaStartFree: 'Talk to us' } as const;
const ADOPTED = { heroH1Line1: 'Adopted winner.' };
const ARM_B = { heroH1Line1: 'Feedback in. Code out.' };

const CONFIG = parseServingConfig({
  environment: 'production',
  surfaces: [{
    surfaceKey: 'home.hero',
    adopted: ADOPTED,
    run: { experimentId: 'e1', epoch: 4, salt: 's', arms: [
      { variationId: 'v-a', weight: 1, payload: ADOPTED },
      { variationId: 'v-b', weight: 1, payload: ARM_B },
    ] },
  }, { surfaceKey: 'home.closing', adopted: { ctaH1: 'Closing winner.' }, run: null }],
  experiments: [{ experimentId: 'e1', surfaceKey: 'home.hero', epoch: 4, salt: 's', arms: [
    { variationId: 'v-a', name: 'control', weight: 1, isControl: true, payload: ADOPTED },
    { variationId: 'v-b', name: 'bold', weight: 1, payload: ARM_B },
  ] }],
  defaults: [{ surfaceKey: 'home.closing', payload: { ctaH1: 'Closing winner.' } }],
}, 'production')!;

/** Two visitor ids, one per arm, found with the shared block itself. */
const run = CONFIG.surfaces['home.hero']!.run!;
const idFor = (variationId: string) => {
  for (let i = 0; ; i++) if (evolveAssign(run, `anon-${i}`) === variationId) return `anon-${i}`;
};
const ID_A = idFor('v-a');
const ID_B = idFor('v-b');

function fakeBoot(o: { config?: ServingConfig | null; settled?: boolean; elapsed?: number } = {}) {
  let settled = o.settled ?? true;
  let config = settled ? (o.config === undefined ? CONFIG : o.config) : null;
  let elapsed = o.elapsed ?? 0;
  let arrival: number | null = settled ? 0 : null;
  const listeners: Array<() => void> = [];
  const handle: EvolveBootHandle = {
    ready: Promise.resolve(),
    settled: () => settled,
    config: () => config,
    elapsed: () => elapsed,
    arrival: () => arrival,
    onSettle: (l) => { if (settled) l(); else listeners.push(l); },
    queueRender: vi.fn(),
    rendersTaken: () => false,
    drainUntakenRenders: () => [],
  };
  return {
    handle,
    advance(ms: number) { elapsed += ms; },
    /** The response arrived `at` ms after the request (resource timing) — its callback has not run yet. */
    arriveAt(at: number) { arrival = at; },
    settle(c: ServingConfig | null = CONFIG, at = elapsed) { settled = true; config = c; if (arrival === null) arrival = at; listeners.splice(0).forEach((l) => l()); },
  };
}

function harness(o: { consent?: boolean; id?: string | null; boot?: ReturnType<typeof fakeBoot> | null; forced?: Record<string, string> } = {}) {
  let consent = o.consent ?? false;
  const consentListeners = new Set<() => void>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const boot = o.boot === undefined ? fakeBoot() : o.boot;
  const queued: RenderEntry[] = [];
  const env: SurfaceEnv = {
    consentGranted: () => consent,
    onConsentChange: vi.fn((listener: () => void) => {
      consentListeners.add(listener);
      return () => { consentListeners.delete(listener); };
    }),
    boot: () => boot?.handle ?? null,
    visitorId: vi.fn(() => (o.id === undefined ? ID_B : o.id)),
    forcedArm: (key) => o.forced?.[key] ?? null,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    reportTimeout: vi.fn((_surfaceKey: string) => {}),
    queueRender: vi.fn((entry: RenderEntry) => { queued.push(entry); }),
  };
  const store = createSurfaceStore(env);
  return {
    store,
    env,
    boot,
    timers,
    queued,
    /** Mount: first read, then React subscribes after commit. */
    mount(key = 'home.hero', fallback: Record<string, string> = HERO) {
      const first = store.read(key, fallback);
      const listener = vi.fn();
      const unsubscribe = store.subscribe(key, listener);
      return { first, listener, unsubscribe, now: () => store.read(key, fallback) };
    },
    grant: () => { consent = true; consentListeners.forEach((l) => l()); },
    fireTimers: () => timers.splice(0).forEach((t) => t.fn()),
  };
}

describe('config already in when React renders (the preloaded case)', () => {
  it('no consent: paints the ADOPTED copy at once, assigns nothing, records nothing, mints no id', () => {
    const h = harness({ consent: false });
    const { first } = h.mount();
    expect(first).toEqual({ settled: true, value: { ...HERO, ...ADOPTED } });
    expect(h.env.visitorId).not.toHaveBeenCalled();
    expect(h.queued).toEqual([]);
  });

  it('no consent, surface with no run: the adopted copy', () => {
    const h = harness({ consent: false });
    expect(h.mount('home.closing', { ctaH1: 'Shipped.' }).first.value).toEqual({ ctaH1: 'Closing winner.' });
  });

  it('no config entry for the surface: the shipped copy itself', () => {
    const h = harness({ consent: false });
    expect(h.mount('home.hero-ko', HERO).first).toEqual({ settled: true, value: HERO });
  });

  it('consent + id: paints the arm the shared block picks, at once, and queues its exposure once the block is on screen', () => {
    for (const [id, payload, variationId] of [[ID_A, ADOPTED, 'v-a'], [ID_B, ARM_B, 'v-b']] as const) {
      const h = harness({ consent: true, id });
      const first = h.store.read('home.hero', HERO);
      expect(first).toEqual({ settled: true, value: { ...HERO, ...payload } });
      // Rendering is not showing: nothing is queued until React commits (subscribes).
      expect(h.queued).toEqual([]);
      h.store.subscribe('home.hero', () => {});
      expect(h.queued).toEqual([{
        surfaceKey: 'home.hero', defaultPayload: HERO, subjectKey: id, experimentId: 'e1', epoch: 4, variationId,
      }]);
      expect(h.env.reportTimeout).not.toHaveBeenCalled();
    }
  });

  it('consent, no run on the surface: the adopted copy, and a declaration (no arm) for the inventory', () => {
    const h = harness({ consent: true });
    const fallback = { ctaH1: 'Shipped.' };
    expect(h.mount('home.closing', fallback).first.value).toEqual({ ctaH1: 'Closing winner.' });
    expect(h.queued).toEqual([{ surfaceKey: 'home.closing', defaultPayload: fallback, subjectKey: ID_B }]);
  });

  it('consent but no countable id (suppressed, or storage that cannot keep one): the adopted copy, nothing queued', () => {
    const h = harness({ consent: true, id: null });
    expect(h.mount().first.value).toEqual({ ...HERO, ...ADOPTED });
    expect(h.queued).toEqual([]);
  });

  it('latches: later reads and remounts return the same snapshot and queue nothing more', () => {
    const h = harness({ consent: true });
    const a = h.mount();
    a.unsubscribe();
    const b = h.mount();
    expect(b.first).toBe(a.first);
    expect(h.queued).toHaveLength(1);
  });

  it('a viewer-forced arm is painted to anyone (by name or id), like the SDK does', () => {
    const h = harness({ consent: false, forced: { 'home.hero': 'bold' } });
    expect(h.mount().first.value).toEqual({ ...HERO, ...ARM_B });
    const tracked = harness({ consent: true, id: ID_A, forced: { 'home.hero': 'v-b' } });
    tracked.mount();
    expect(tracked.queued[0]).toMatchObject({ variationId: 'v-b', subjectKey: ID_A });
  });

  it('no boot at all (a failure before React): the shipped copy at once', () => {
    const h = harness({ consent: true, boot: null });
    expect(h.mount().first).toEqual({ settled: true, value: HERO });
  });
});

describe('config still in flight at first render (R114e)', () => {
  it('waits invisibly — for the CONFIG, not the SDK — and paints the arm when it arrives inside the cap', () => {
    const boot = fakeBoot({ settled: false, elapsed: 30 });
    const h = harness({ consent: true, id: ID_B, boot });
    const m = h.mount();
    expect(m.first).toEqual({ settled: false, value: HERO });
    expect(h.timers).toEqual([{ fn: expect.any(Function), ms: SURFACE_WAIT_MS - 30 }]);
    boot.advance(150);
    boot.settle();
    expect(m.now()).toEqual({ settled: true, value: { ...HERO, ...ARM_B } });
    expect(m.listener).toHaveBeenCalled();
    expect(h.queued).toHaveLength(1);
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });

  it('no consent waits the same way and paints the adopted copy', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: false, boot });
    const m = h.mount();
    expect(m.first.settled).toBe(false);
    boot.settle();
    expect(m.now()).toEqual({ settled: true, value: { ...HERO, ...ADOPTED } });
  });

  it('past the cap: paints the shipped copy, reports the timeout, declares the surface, and never swaps when the config lands', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: true, id: ID_B, boot });
    const m = h.mount();
    boot.advance(SURFACE_WAIT_MS + 1);
    h.fireTimers();
    const painted = m.now();
    expect(painted).toEqual({ settled: true, value: HERO });
    expect(h.env.reportTimeout).toHaveBeenCalledWith('home.hero');
    expect(h.queued).toEqual([{ surfaceKey: 'home.hero', defaultPayload: HERO, subjectKey: ID_B }]);
    boot.settle();
    expect(m.now()).toBe(painted);
    expect(h.queued).toHaveLength(1);
  });

  it('judges by arrival, not by when a busy main thread ran the timer: an answer that arrived in time is used', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: true, id: ID_B, boot });
    const m = h.mount();
    boot.arriveAt(180);          // the response was in at 180 ms…
    boot.advance(2_000);         // …but the thread was busy until 2 s
    h.fireTimers();              // the late timer sees it arrived in time: keep waiting for its callback
    expect(m.now().settled).toBe(false);
    boot.settle();
    expect(m.now()).toEqual({ settled: true, value: { ...HERO, ...ARM_B } });
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });

  it('an answer that arrived after the cap is not used, even if its callback beats the timer', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: true, id: ID_B, boot });
    const m = h.mount();
    boot.advance(900);
    boot.settle(CONFIG, 900);
    expect(m.now()).toEqual({ settled: true, value: HERO });
    expect(h.env.reportTimeout).toHaveBeenCalledTimes(1);
    h.fireTimers();
    expect(h.env.reportTimeout).toHaveBeenCalledTimes(1);
  });

  it('a first render already past the cap paints at once, without hiding', () => {
    const boot = fakeBoot({ settled: false, elapsed: SURFACE_WAIT_MS + 50 });
    const h = harness({ consent: false, boot });
    expect(h.mount().first).toEqual({ settled: true, value: HERO });
    expect(h.timers).toEqual([]);
  });

  it('never reports a timeout for a visitor without consent', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: false, boot });
    h.mount();
    boot.advance(SURFACE_WAIT_MS);
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
    expect(h.queued).toEqual([]);
  });

  it('a config that settles unusable paints the shipped copy', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: true, boot });
    const m = h.mount();
    boot.settle(null, 50);
    expect(m.now()).toEqual({ settled: true, value: HERO });
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });
});

describe('consent granted during the page load (R18/R19)', () => {
  it('a surface on screen is assigned at once, synchronously with the Accept, and its exposure queued', () => {
    const h = harness({ consent: false, id: ID_B });
    const m = h.mount();
    expect(m.first.value).toEqual({ ...HERO, ...ADOPTED });
    h.grant();
    expect(m.listener).toHaveBeenCalled();
    expect(m.now()).toEqual({ settled: true, value: { ...HERO, ...ARM_B } });
    expect(h.queued).toMatchObject([{ variationId: 'v-b', subjectKey: ID_B }]);
  });

  it('a surface off screen is read with the tracker on at its next mount, never in the background', () => {
    const h = harness({ consent: false, id: ID_B });
    h.mount().unsubscribe();
    h.grant();
    expect(h.queued).toEqual([]);
    expect(h.mount().first.value).toEqual({ ...HERO, ...ARM_B });
    expect(h.queued).toHaveLength(1);
  });

  it('consent that arrived without a signal (another tab) is picked up by the next read', () => {
    const h = harness({ consent: false, id: ID_B });
    const m = h.mount();
    h.env.consentGranted = () => true;
    expect(m.now().value).toEqual({ ...HERO, ...ARM_B });
    expect(h.queued).toHaveLength(1);
  });

  it('an unconsented surface is a stable snapshot for as long as nothing changes', () => {
    const h = harness({ consent: false });
    const m = h.mount();
    expect(m.now()).toBe(m.first);
    m.unsubscribe();
    expect(h.mount().first).toBe(m.first);
  });

  it('a remount after a past-cap shipped paint shows what the config now says', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: false, boot });
    const m = h.mount();
    boot.advance(SURFACE_WAIT_MS);
    h.fireTimers();
    expect(m.now().value).toEqual(HERO);
    boot.settle();
    expect(m.now().value).toEqual(HERO); // on screen: no swap
    m.unsubscribe();
    expect(h.mount().first.value).toEqual({ ...HERO, ...ADOPTED });
  });

  it('watches consent only once something subscribes — importing the store touches no window', () => {
    const h = harness();
    expect(h.env.onConsentChange).not.toHaveBeenCalled();
    h.mount();
    h.mount('home.closing', { ctaH1: 'x' });
    expect(h.env.onConsentChange).toHaveBeenCalledTimes(1);
  });
});

describe('robustness', () => {
  it('still settles when reporting the timeout throws', () => {
    const boot = fakeBoot({ settled: false });
    const h = harness({ consent: true, boot });
    h.env.reportTimeout = () => { throw new Error('boom'); };
    const m = h.mount();
    boot.advance(SURFACE_WAIT_MS);
    h.fireTimers();
    expect(m.now()).toEqual({ settled: true, value: HERO });
  });

  it('still paints when handing the render to the SDK throws', () => {
    const h = harness({ consent: true });
    h.env.queueRender = () => { throw new Error('boom'); };
    expect(h.mount().first.value).toEqual({ ...HERO, ...ARM_B });
  });
});

describe('mergeFields', () => {
  it('returns the default itself when the payload supplies nothing new', () => {
    expect(mergeFields(undefined, HERO)).toBe(HERO);
    expect(mergeFields({ heroH1Line1: HERO.heroH1Line1 }, HERO)).toBe(HERO);
  });

  it('takes string fields, keeps the default for missing, blank or non-string ones, and ignores extras', () => {
    expect(mergeFields({ heroH1Line1: 'New.', ctaStartFree: '  ', extra: 'x' }, HERO)).toEqual({ heroH1Line1: 'New.', ctaStartFree: 'Talk to us' });
    expect(mergeFields({ heroH1Line1: 7 }, HERO)).toBe(HERO);
    expect(mergeFields(['x'], HERO)).toBe(HERO);
  });
});
