import { describe, expect, it, vi } from 'vitest';
import type { EvolveBoot } from './bootConfig';

/**
 * The page's own Evolve config fetch. It starts before React mounts, so the
 * hero's answer is in flight at first paint and the SDK can adopt the request
 * instead of making its own (be/public/widget.js evolveFetchConfig).
 */

const SERVED = {
  environment: 'staging',
  experiments: [{
    experimentId: 'e1', key: 'hero', surfaceKey: 'home.hero', epoch: 0, salt: 's',
    arms: [
      { variationId: 'v-control', name: 'control', weight: 1, payload: { heroH1Line1: 'Signal-to-code.' }, isControl: true },
      { variationId: 'v-sharp', name: 'sharper', weight: 1, payload: { heroH1Line1: 'Feedback in. Code out.' }, isControl: false },
    ],
  }],
  defaults: [{ surfaceKey: 'home.closing', payload: { ctaH1: 'Winner.' } }],
};

/** bootConfig holds the settled config in module state: a fresh module per test. */
async function fresh() {
  vi.resetModules();
  return import('./bootConfig');
}

const respond = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });

const ARGS = { apiBase: 'https://console-staging.runhq.io', project: 'runhq', environment: 'staging' };

describe('startEvolveBoot', () => {
  it('starts the request at once and publishes the versioned envelope the SDK reads', async () => {
    const { startEvolveBoot } = await fresh();
    const fetchImpl = respond(SERVED);
    const target: { __runhqEvolve?: EvolveBoot } = {};
    startEvolveBoot({ ...ARGS, fetchImpl, now: () => 1_000, target });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://console-staging.runhq.io/api/widget/evolve/config?project=runhq&environment=staging',
      { credentials: 'omit' },
    );
    expect(target.__runhqEvolve).toMatchObject({ v: 1, project: 'runhq', environment: 'staging', startedAt: 1_000 });
    await expect(target.__runhqEvolve!.config).resolves.toEqual(SERVED);
  });

  it('holds the settled config for synchronous reads, and only once it has settled', async () => {
    const { startEvolveBoot, bootConfigSnapshot } = await fresh();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(SERVED), target: {} });
    expect(bootConfigSnapshot()).toBeNull();
    await boot.config;
    expect(bootConfigSnapshot()).toEqual(SERVED);
  });

  it('resolves null for another environment’s config', async () => {
    const { startEvolveBoot, bootConfigSnapshot } = await fresh();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond({ ...SERVED, environment: 'production' }), target: {} });
    await expect(boot.config).resolves.toBeNull();
    expect(bootConfigSnapshot()).toBeNull();
  });

  it.each([
    ['an HTTP error', () => respond(SERVED, false)],
    ['a network failure', () => vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))],
    ['a fetch that throws synchronously', () => vi.fn(() => { throw new Error('no fetch'); })],
    ['a malformed body', () => respond({ environment: 'staging', experiments: 'nope' })],
  ])('resolves null on %s — the page renders its shipped copy', async (_label, make) => {
    const { startEvolveBoot } = await fresh();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: make() as never, target: {} });
    await expect(boot.config).resolves.toBeNull();
  });
});

describe('parseServingConfig', () => {
  it('accepts the route’s shape and fills absent defaults with an empty list', async () => {
    const { parseServingConfig } = await fresh();
    expect(parseServingConfig({ environment: 'staging', experiments: [] }, 'staging')).toEqual({
      environment: 'staging', experiments: [], defaults: [],
    });
  });

  it.each([
    ['not an object', 'x'],
    ['another environment', { ...SERVED, environment: 'production' }],
    ['an arm with a text weight', { ...SERVED, experiments: [{ ...SERVED.experiments[0], arms: [{ variationId: 'a', name: 'a', weight: '1', payload: 1 }] }] }],
    ['an arm whose isControl is not a boolean', { ...SERVED, experiments: [{ ...SERVED.experiments[0], arms: [{ variationId: 'a', name: 'a', weight: 1, payload: 1, isControl: 1 }] }] }],
    ['an experiment with no salt', { ...SERVED, experiments: [{ ...SERVED.experiments[0], salt: undefined }] }],
    ['defaults that are not a list', { ...SERVED, defaults: {} }],
  ])('rejects %s', async (_label, raw) => {
    const { parseServingConfig } = await fresh();
    expect(parseServingConfig(raw, 'staging')).toBeNull();
  });
});

describe('untrackedPayload — what a visitor we cannot assign sees', () => {
  it('is the control while a run is live on the surface, never an arm', async () => {
    const { untrackedPayload } = await fresh();
    expect(untrackedPayload(SERVED, 'home.hero')).toEqual({ heroH1Line1: 'Signal-to-code.' });
  });

  it('is the adopted winner where no run is live', async () => {
    const { untrackedPayload } = await fresh();
    expect(untrackedPayload(SERVED, 'home.closing')).toEqual({ ctaH1: 'Winner.' });
  });

  it('is undefined when the config says nothing about the surface, or there is no config', async () => {
    const { untrackedPayload } = await fresh();
    expect(untrackedPayload(SERVED, 'home.hero-ko')).toBeUndefined();
    expect(untrackedPayload(null, 'home.hero')).toBeUndefined();
  });
});

describe('shouldBootEvolve', () => {
  it('boots on marketing pages and never on a customer’s board', async () => {
    const { shouldBootEvolve } = await fresh();
    expect(shouldBootEvolve('/')).toBe(true);
    expect(shouldBootEvolve('/ko')).toBe(true);
    expect(shouldBootEvolve('/pricing')).toBe(true);
    expect(shouldBootEvolve('/arrr')).toBe(false);
    expect(shouldBootEvolve('/ko/arrr')).toBe(false);
  });
});
