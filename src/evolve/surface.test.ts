import { describe, expect, it, vi } from 'vitest';
import {
  createSurfaceStore,
  mergeFields,
  SURFACE_CONSENT_WAIT_MS,
  SURFACE_WAIT_MS,
  type EvolveSdk,
  type SurfaceEnv,
} from './surface';
import type { ServingConfig } from './bootConfig';

const HERO = { heroH1Line1: 'Signal-to-code.', ctaStartFree: 'Talk to us' } as const;
const ARM = { heroH1Line1: 'Feedback in. Code out.' };
const ARM_VIEW = { heroH1Line1: 'Feedback in. Code out.', ctaStartFree: 'Talk to us' };
const CONTROL_VIEW = { heroH1Line1: 'Control copy.', ctaStartFree: 'Talk to us' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeSdk(payload: unknown) {
  const ready = deferred<void>();
  const sdk = { ready: vi.fn(() => ready.promise), variation: vi.fn((_key: string, _fallback: unknown) => payload) };
  return { sdk, ready };
}

function harness(o: { consent?: boolean; config?: ServingConfig | null } = {}) {
  let consent = o.consent ?? true;
  const consentListeners = new Set<() => void>();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sdkLoad = deferred<EvolveSdk | null>();
  const env: SurfaceEnv = {
    consentGranted: () => consent,
    onConsentChange: vi.fn((listener: () => void) => {
      consentListeners.add(listener);
      return () => { consentListeners.delete(listener); };
    }),
    configSnapshot: () => o.config ?? null,
    loadSdk: vi.fn(() => sdkLoad.promise),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    reportTimeout: vi.fn((_surfaceKey: string) => {}),
  };
  const signal = () => consentListeners.forEach((listener) => listener());
  return {
    store: createSurfaceStore(env),
    env,
    timers,
    sdkLoad,
    /** The consent bar's Accept: storage first, then the change event. */
    grant: () => { consent = true; signal(); },
    /** Consent granted where no signal reaches this tab's store (e.g. accepted in another tab, event missed). */
    grantSilently: () => { consent = true; },
    /** Decline (or any change that is not a grant). */
    decline: () => { consent = false; signal(); },
    fireTimers: () => timers.splice(0).forEach((t) => t.fn()),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const RUNNING: ServingConfig = {
  environment: 'production',
  experiments: [{
    experimentId: 'e1', surfaceKey: 'home.hero', epoch: 0, salt: 's',
    arms: [
      { variationId: 'c', name: 'control', weight: 1, payload: { heroH1Line1: 'Control copy.' }, isControl: true },
      { variationId: 'a', name: 'sharper', weight: 1, payload: ARM, isControl: false },
    ],
  }],
  defaults: [],
};

describe('an unconsented visitor', () => {
  it('paints the shipped default at once and never touches the SDK', () => {
    const h = harness({ consent: false });
    const snap = h.store.read('home.hero', HERO);
    expect(snap).toEqual({ value: HERO, settled: true });
    expect(snap.value).toBe(HERO);
    expect(h.env.loadSdk).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('sees a promoted winner when the boot config already holds it', () => {
    const h = harness({
      consent: false,
      config: { environment: 'production', experiments: [], defaults: [{ surfaceKey: 'home.hero', payload: ARM }] },
    });
    expect(h.store.read('home.hero', HERO).value).toEqual(ARM_VIEW);
  });

  it('sees the control — never an arm — while a run is live', () => {
    const h = harness({ consent: false, config: RUNNING });
    expect(h.store.read('home.hero', HERO).value).toEqual(CONTROL_VIEW);
  });

  it('is not latched, yet reads as the same snapshot for as long as consent is absent', () => {
    const h = harness({ consent: false });
    const first = h.store.read('home.hero', HERO);
    h.store.subscribe('home.hero', vi.fn());
    h.decline();
    expect(h.store.read('home.hero', HERO)).toBe(first);
    expect(h.store.read('home.hero', HERO)).toBe(first);
    expect(h.env.loadSdk).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });
});

describe('consent granted during the page load (ruling R18)', () => {
  it('a visitor who consents on this page load is assigned on the re-render, and the pre-consent paint recorded no exposure', async () => {
    const h = harness({ consent: false, config: RUNNING });
    const { sdk, ready } = fakeSdk(ARM);
    const painted = h.store.read('home.hero', HERO);
    const listener = vi.fn();
    h.store.subscribe('home.hero', listener);
    expect(painted).toEqual({ value: CONTROL_VIEW, settled: true });
    // The pre-consent paint never reached the SDK: no variation(), so no exposure.
    expect(h.env.loadSdk).not.toHaveBeenCalled();

    h.grant();
    // The painted copy stays on screen while the tracker starts — nothing is hidden.
    expect(h.store.read('home.hero', HERO)).toBe(painted);
    expect(h.env.loadSdk).toHaveBeenCalledTimes(1);
    expect(h.timers.map((t) => t.ms)).toEqual([SURFACE_CONSENT_WAIT_MS]);
    expect(sdk.variation).not.toHaveBeenCalled();

    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();

    // The re-read with the tracker on is the assignment, and the exposure starts here.
    expect(sdk.variation).toHaveBeenCalledTimes(1);
    expect(sdk.variation).toHaveBeenCalledWith('home.hero', HERO);
    expect(listener).toHaveBeenCalledTimes(1);
    const assigned = h.store.read('home.hero', HERO);
    expect(assigned).toEqual({ value: ARM_VIEW, settled: true });
    // Latched from here on: a tracked read.
    h.grant();
    expect(h.store.read('home.hero', HERO)).toBe(assigned);
    expect(sdk.variation).toHaveBeenCalledTimes(1);
  });

  it('a surface off screen when consent arrives is not read then — it is read with the tracker on at its next mount', async () => {
    const h = harness({ consent: false });
    const { sdk, ready } = fakeSdk(ARM);
    h.store.read('home.closing', HERO); // painted once, then unmounted: no subscriber
    h.grant();
    expect(h.env.loadSdk).not.toHaveBeenCalled();

    const remount = h.store.read('home.closing', HERO);
    expect(remount).toEqual({ value: HERO, settled: false });
    expect(h.timers.map((t) => t.ms)).toEqual([SURFACE_WAIT_MS]);
    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    expect(h.store.read('home.closing', HERO)).toEqual({ value: ARM_VIEW, settled: true });
    expect(sdk.variation).toHaveBeenCalledTimes(1);
  });

  it('gives up at SURFACE_CONSENT_WAIT_MS keeping the painted copy, latches, and never reads the arm late', async () => {
    const h = harness({ consent: false, config: RUNNING });
    const { sdk, ready } = fakeSdk(ARM);
    h.store.read('home.hero', HERO);
    h.store.subscribe('home.hero', vi.fn());
    h.grant();
    h.fireTimers();
    const settled = h.store.read('home.hero', HERO);
    expect(settled).toEqual({ value: CONTROL_VIEW, settled: true });

    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    expect(sdk.variation).not.toHaveBeenCalled();
    h.grant();
    expect(h.store.read('home.hero', HERO)).toBe(settled);
    expect(h.env.loadSdk).toHaveBeenCalledTimes(1);
  });

  it('re-reads a painted surface even when consent arrived without the change signal (another tab)', async () => {
    const h = harness({ consent: false });
    const { sdk, ready } = fakeSdk(ARM);
    const painted = h.store.read('home.hero', HERO);
    h.store.subscribe('home.hero', vi.fn());
    h.grantSilently();
    expect(h.store.read('home.hero', HERO)).toBe(painted);
    expect(h.timers.map((t) => t.ms)).toEqual([SURFACE_CONSENT_WAIT_MS]);
    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    expect(h.store.read('home.hero', HERO)).toEqual({ value: ARM_VIEW, settled: true });
  });

  it('watches consent only once something subscribes — importing the store touches no window', () => {
    const h = harness({ consent: false });
    h.store.read('home.hero', HERO);
    expect(h.env.onConsentChange).not.toHaveBeenCalled();
    h.store.subscribe('home.hero', vi.fn());
    h.store.subscribe('home.hero', vi.fn());
    expect(h.env.onConsentChange).toHaveBeenCalledTimes(1);
  });
});

describe('a visitor who had consented before this page load', () => {
  it('stays unsettled, then settles on the SDK’s arm inside the window', async () => {
    const h = harness();
    const { sdk, ready } = fakeSdk(ARM);
    const listener = vi.fn();
    const pending = h.store.read('home.hero', HERO);
    h.store.subscribe('home.hero', listener);
    expect(pending).toEqual({ value: HERO, settled: false });
    expect(h.timers.map((t) => t.ms)).toEqual([SURFACE_WAIT_MS]);
    expect(SURFACE_WAIT_MS).toBe(400);

    h.sdkLoad.resolve(sdk);
    await flush();
    expect(h.store.read('home.hero', HERO).settled).toBe(false);
    ready.resolve();
    await flush();

    expect(h.store.read('home.hero', HERO)).toEqual({ value: ARM_VIEW, settled: true });
    expect(sdk.variation).toHaveBeenCalledWith('home.hero', HERO);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gives up at 400 ms, paints what an unconsented visitor would see, and never reads the arm afterwards', async () => {
    const h = harness({ config: RUNNING });
    const { sdk, ready } = fakeSdk(ARM);
    h.store.read('home.hero', HERO);
    h.fireTimers();
    const settled = h.store.read('home.hero', HERO);
    expect(settled).toEqual({ value: CONTROL_VIEW, settled: true });

    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    // Reading the arm IS the exposure — a visitor who never saw it must not be counted in it.
    expect(sdk.variation).not.toHaveBeenCalled();
    expect(h.store.read('home.hero', HERO)).toBe(settled);
  });

  it('latches: every later read in the page load returns the same snapshot and reads the SDK once', async () => {
    const h = harness();
    const { sdk, ready } = fakeSdk(ARM);
    h.store.read('home.hero', HERO);
    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    const once = h.store.read('home.hero', HERO);
    expect(h.store.read('home.hero', HERO)).toBe(once);
    expect(h.store.read('home.hero', HERO)).toBe(once);
    expect(sdk.variation).toHaveBeenCalledTimes(1);
    expect(h.env.loadSdk).toHaveBeenCalledTimes(1);
  });

  it('reads each locale’s surface on its own', async () => {
    const h = harness();
    const { sdk, ready } = fakeSdk(undefined);
    h.store.read('home.hero', HERO);
    h.store.read('home.hero-ko', { heroH1Line1: '시그널에서 코드로.', ctaStartFree: '문의하기' });
    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    expect(sdk.variation.mock.calls.map((c) => c[0])).toEqual(['home.hero', 'home.hero-ko']);
  });

  it('settles at once with the untracked value when the SDK has no Evolve half (an older cached script)', async () => {
    const h = harness();
    h.store.read('home.hero', HERO);
    h.sdkLoad.resolve(null);
    await flush();
    expect(h.store.read('home.hero', HERO)).toEqual({ value: HERO, settled: true });
  });

  it('settles with the untracked value when ready() rejects or variation() throws', async () => {
    const rejecting = harness();
    const r = fakeSdk(ARM);
    rejecting.store.read('home.hero', HERO);
    rejecting.sdkLoad.resolve(r.sdk);
    r.ready.reject(new Error('offline'));
    await flush();
    expect(rejecting.store.read('home.hero', HERO)).toEqual({ value: HERO, settled: true });

    const throwing = harness();
    const t = fakeSdk(ARM);
    t.sdk.variation.mockImplementation(() => { throw new Error('boom'); });
    throwing.store.read('home.hero', HERO);
    throwing.sdkLoad.resolve(t.sdk);
    t.ready.resolve();
    await flush();
    expect(throwing.store.read('home.hero', HERO)).toEqual({ value: HERO, settled: true });
  });
});

describe('mergeFields', () => {
  it('returns the default itself when the payload supplies nothing new', () => {
    expect(mergeFields({ heroH1Line1: 'Signal-to-code.' }, HERO)).toBe(HERO);
    expect(mergeFields(HERO, HERO)).toBe(HERO);
  });

  it('takes string fields, keeps the default for missing, blank or non-string ones, and ignores extras', () => {
    expect(
      mergeFields({ heroH1Line1: 'New.', ctaStartFree: '   ', extra: 'ignored' }, HERO),
    ).toEqual({ heroH1Line1: 'New.', ctaStartFree: 'Talk to us' });
    expect(mergeFields({ heroH1Line1: 42, ctaStartFree: 'Book a call' }, HERO)).toEqual({
      heroH1Line1: 'Signal-to-code.', ctaStartFree: 'Book a call',
    });
  });

  it.each([[null], [undefined], ['a string'], [3], [['heroH1Line1']]])('falls back entirely for %j', (payload) => {
    expect(mergeFields(payload, HERO)).toBe(HERO);
  });
});

describe('a tracked read abandoned at its cap is reported (ruling R45)', () => {
  it('reports evolve_surface_timeout once for a consented first read that hits SURFACE_WAIT_MS', () => {
    const h = harness();
    h.store.read('home.hero', HERO);
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
    h.fireTimers();
    expect(h.env.reportTimeout).toHaveBeenCalledTimes(1);
    expect(h.env.reportTimeout).toHaveBeenCalledWith('home.hero');
    // Latched: later reads in the page load never report again.
    h.store.read('home.hero', HERO);
    h.fireTimers();
    expect(h.env.reportTimeout).toHaveBeenCalledTimes(1);
  });

  it('reports the consent-arrival re-read that hits SURFACE_CONSENT_WAIT_MS', () => {
    const h = harness({ consent: false });
    h.store.read('home.hero', HERO);
    h.store.subscribe('home.hero', vi.fn());
    h.grant();
    h.fireTimers();
    expect(h.env.reportTimeout).toHaveBeenCalledTimes(1);
    expect(h.env.reportTimeout).toHaveBeenCalledWith('home.hero');
  });

  it('reports each surface on its own', () => {
    const h = harness();
    h.store.read('home.hero', HERO);
    h.store.read('home.closing', HERO);
    h.fireTimers();
    expect(vi.mocked(h.env.reportTimeout).mock.calls).toEqual([['home.hero'], ['home.closing']]);
  });

  it('does not report a read that settled on the arm inside the cap', async () => {
    const h = harness();
    const { sdk, ready } = fakeSdk(ARM);
    h.store.read('home.hero', HERO);
    h.sdkLoad.resolve(sdk);
    ready.resolve();
    await flush();
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });

  it('does not report a read that settled early because the SDK has no Evolve half', async () => {
    const h = harness();
    h.store.read('home.hero', HERO);
    h.sdkLoad.resolve(null);
    await flush();
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });

  it('never reports for a visitor without consent — nothing is tracked for them', () => {
    const h = harness({ consent: false });
    h.store.read('home.hero', HERO);
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
  });

  it('does not report when consent was withdrawn before the cap fired', () => {
    const h = harness();
    h.store.read('home.hero', HERO);
    h.decline();
    h.fireTimers();
    expect(h.env.reportTimeout).not.toHaveBeenCalled();
    expect(h.store.read('home.hero', HERO).settled).toBe(true);
  });

  it('still settles the surface when reporting throws', () => {
    const h = harness();
    vi.mocked(h.env.reportTimeout).mockImplementation(() => { throw new Error('boom'); });
    h.store.read('home.hero', HERO);
    expect(() => h.fireTimers()).not.toThrow();
    expect(h.store.read('home.hero', HERO)).toEqual({ value: HERO, settled: true });
  });
});
