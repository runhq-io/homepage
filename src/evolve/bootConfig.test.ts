import { describe, expect, it, vi } from 'vitest';
import type { EvolveBoot, EvolveBootHandle, RenderEntry } from './bootConfig';

/**
 * The page's own Evolve config fetch (R114a, R114e, R118).
 *
 * The copy a visitor sees is decided from THIS config at first render, never
 * by waiting on the SDK. So it is fetched before React mounts (and preloaded
 * from index.html), timed from the moment the page asked for it, and read in
 * both spellings the route has served: the run-major `experiments`/`defaults`
 * (today's BE) and the per-surface `surfaces` (R107, fix wave B) — the
 * homepage ships after the BE, but must render right against either.
 */

const OLD_SHAPE = {
  environment: 'staging',
  experiments: [{
    experimentId: 'e1', key: 'hero', surfaceKey: 'home.hero', epoch: 2, salt: 's',
    arms: [
      { variationId: 'v-control', name: 'control', weight: 1, payload: { heroH1Line1: 'Adopted.' }, isControl: true },
      { variationId: 'v-sharp', name: 'sharper', weight: 1, payload: { heroH1Line1: 'Feedback in. Code out.' }, isControl: false },
    ],
  }],
  defaults: [{ surfaceKey: 'home.closing', payload: { ctaH1: 'Winner.' } }],
};

/** What a BE with R107 answers: both spellings, `surfaces` authoritative. */
const NEW_SHAPE = {
  ...OLD_SHAPE,
  surfaces: [
    { surfaceKey: 'home.closing', adopted: { ctaH1: 'Winner.' }, run: null },
    {
      surfaceKey: 'home.hero',
      adopted: { heroH1Line1: 'Adopted.' },
      run: {
        experimentId: 'e1', epoch: 2, salt: 's',
        arms: [
          { variationId: 'v-control', weight: 1, payload: { heroH1Line1: 'Adopted.' } },
          { variationId: 'v-sharp', weight: 1, payload: { heroH1Line1: 'Feedback in. Code out.' } },
        ],
      },
    },
  ],
};

/** bootConfig holds the current boot in module state: a fresh module per test. */
async function fresh() {
  vi.resetModules();
  return import('./bootConfig');
}

const respond = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });

const ARGS = { apiBase: 'https://console-staging.runhq.io', project: 'runhq', environment: 'staging' };
const URL_ = 'https://console-staging.runhq.io/api/widget/evolve/config?project=runhq&environment=staging';

describe('startEvolveBoot', () => {
  it('starts the request at once, in the mode the index.html preload uses, and publishes the envelope the SDK reads', async () => {
    const { startEvolveBoot, evolveConfigRequestInit } = await fresh();
    const fetchImpl = respond(NEW_SHAPE);
    const target: { __runhqEvolve?: EvolveBoot } = {};
    startEvolveBoot({ ...ARGS, fetchImpl, now: () => 1_000, target });
    expect(fetchImpl).toHaveBeenCalledWith(URL_, evolveConfigRequestInit);
    // A preload is reused only by a request with the same mode and credentials
    // mode; `crossorigin="anonymous"` is mode cors + credentials same-origin,
    // which sends no cookies to the (cross-origin) API, like `omit` did.
    expect(evolveConfigRequestInit).toEqual({ mode: 'cors', credentials: 'same-origin' });
    expect(target.__runhqEvolve).toMatchObject({ v: 1, project: 'runhq', environment: 'staging', startedAt: 1_000, renders: [] });
    // The SDK validates its own spelling, so it is handed the raw answer.
    await expect(target.__runhqEvolve!.config).resolves.toEqual(NEW_SHAPE);
  });

  it('is pending until the answer has settled, then holds it for synchronous reads', async () => {
    const { startEvolveBoot } = await fresh();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {} });
    expect(boot.settled()).toBe(false);
    expect(boot.config()).toBeNull();
    await boot.ready;
    expect(boot.settled()).toBe(true);
    expect(boot.config()?.surfaces['home.hero']?.run?.experimentId).toBe('e1');
  });

  it('times the answer from the moment the page asked, by the response’s own arrival where the browser records it', async () => {
    const { startEvolveBoot } = await fresh();
    let clock = 100;
    let arrivedAt: number | null = null;
    const boot = startEvolveBoot({
      ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {},
      clock: () => clock,
      responseEnd: (url) => (url === URL_ ? arrivedAt : null),
    });
    clock = 350;
    expect(boot.elapsed()).toBe(250);
    expect(boot.arrival()).toBeNull();
    // The response is in (resource timing), though its callback has not run yet.
    arrivedAt = 220;
    expect(boot.arrival()).toBe(120);
    clock = 2_000; // a busy main thread runs the callback late
    await boot.ready;
    expect(boot.arrival()).toBe(120);
  });

  it('times by the callback when the browser records no arrival, and a preload that finished early counts as 0', async () => {
    const { startEvolveBoot } = await fresh();
    let clock = 100;
    const late = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {}, clock: () => clock, responseEnd: () => null });
    clock = 700;
    await late.ready;
    expect(late.arrival()).toBe(600);
    const preloaded = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {}, clock: () => 900, responseEnd: () => 40 });
    expect(preloaded.arrival()).toBe(0);
  });

  it('tells settle listeners, including one added after it settled', async () => {
    const { startEvolveBoot } = await fresh();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {} });
    const early = vi.fn();
    boot.onSettle(early);
    await boot.ready;
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    boot.onSettle(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an HTTP error', () => respond(NEW_SHAPE, false)],
    ['a network failure', () => vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))],
    ['a fetch that throws synchronously', () => vi.fn(() => { throw new Error('no fetch'); })],
    ['a malformed body', () => respond({ environment: 'staging', experiments: 'nope' })],
    ['another environment’s config', () => respond({ ...NEW_SHAPE, environment: 'production' })],
  ])('settles with no config on %s — the page renders its shipped copy', async (_label, make) => {
    const { startEvolveBoot } = await fresh();
    const target: { __runhqEvolve?: EvolveBoot } = {};
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: make() as never, target });
    await boot.ready;
    expect(boot.settled()).toBe(true);
    expect(boot.config()).toBeNull();
    await expect(target.__runhqEvolve!.config).resolves.toBeNull();
  });

  it('is what currentBoot() answers once started', async () => {
    const { startEvolveBoot, currentBoot } = await fresh();
    expect(currentBoot()).toBeNull();
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target: {} });
    expect(currentBoot()).toBe(boot);
  });
});

describe('parseServingConfig — both spellings (R118)', () => {
  it('reads the per-surface spelling: adopted copy and the run with what assignment needs', async () => {
    const { parseServingConfig } = await fresh();
    const parsed = parseServingConfig(NEW_SHAPE, 'staging')!;
    expect(parsed.surfaces['home.closing']).toEqual({ surfaceKey: 'home.closing', adopted: { ctaH1: 'Winner.' }, run: null });
    expect(parsed.surfaces['home.hero']).toEqual({
      surfaceKey: 'home.hero',
      adopted: { heroH1Line1: 'Adopted.' },
      run: {
        experimentId: 'e1', epoch: 2, salt: 's',
        arms: [
          // Names come from the run-major spelling when it names the same run (viewer overrides use them).
          { variationId: 'v-control', name: 'control', weight: 1, payload: { heroH1Line1: 'Adopted.' } },
          { variationId: 'v-sharp', name: 'sharper', weight: 1, payload: { heroH1Line1: 'Feedback in. Code out.' } },
        ],
      },
    });
  });

  it('reads the run-major spelling the same way: the control is what an unassigned visitor sees', async () => {
    const { parseServingConfig } = await fresh();
    const { surfaces: _drop, ...old } = NEW_SHAPE;
    expect(parseServingConfig(old, 'staging')).toEqual(parseServingConfig(NEW_SHAPE, 'staging'));
    expect(parseServingConfig(OLD_SHAPE, 'staging')).toEqual(parseServingConfig(NEW_SHAPE, 'staging'));
  });

  it('a run with no control, in the run-major spelling, adopts nothing: the shipped copy', async () => {
    const { parseServingConfig } = await fresh();
    const noControl = { ...OLD_SHAPE, experiments: [{ ...OLD_SHAPE.experiments[0], arms: OLD_SHAPE.experiments[0].arms.map((a) => ({ ...a, isControl: false })) }] };
    expect(parseServingConfig(noControl, 'staging')!.surfaces['home.hero']!.adopted).toBeUndefined();
  });

  it('an adopted copy of null means the shipped copy', async () => {
    const { parseServingConfig } = await fresh();
    const parsed = parseServingConfig({ environment: 'staging', surfaces: [{ surfaceKey: 'home.hero', adopted: null, run: null }] }, 'staging')!;
    expect(parsed.surfaces['home.hero']!.adopted).toBeUndefined();
  });

  it.each([
    ['not an object', 'x'],
    ['another environment', { ...NEW_SHAPE, environment: 'production' }],
    ['neither spelling', { environment: 'staging' }],
    ['an arm with a text weight (run-major)', { ...OLD_SHAPE, experiments: [{ ...OLD_SHAPE.experiments[0], arms: [{ variationId: 'a', name: 'a', weight: '1', payload: 1 }] }] }],
    ['an experiment with no salt', { ...OLD_SHAPE, experiments: [{ ...OLD_SHAPE.experiments[0], salt: undefined }] }],
    ['defaults that are not a list', { ...OLD_SHAPE, defaults: {} }],
    ['surfaces that are not a list', { environment: 'staging', surfaces: {} }],
    ['a surface with no key', { environment: 'staging', surfaces: [{ adopted: null, run: null }] }],
    ['a run arm with a text weight', { environment: 'staging', surfaces: [{ surfaceKey: 'k', adopted: null, run: { experimentId: 'e', epoch: 0, salt: 's', arms: [{ variationId: 'a', weight: '1', payload: 1 }] } }] }],
    ['a run with no epoch', { environment: 'staging', surfaces: [{ surfaceKey: 'k', adopted: null, run: { experimentId: 'e', salt: 's', arms: [] } }] }],
  ])('rejects %s', async (_label, raw) => {
    const { parseServingConfig } = await fresh();
    expect(parseServingConfig(raw, 'staging')).toBeNull();
  });
});

describe('the render queue (R114d) and an SDK that predates it (R118)', () => {
  const entry = (over: Partial<RenderEntry> = {}): RenderEntry => ({
    surfaceKey: 'home.hero', defaultPayload: { heroH1Line1: 'Shipped.' }, subjectKey: 'anon-1',
    experimentId: 'e1', epoch: 2, variationId: 'v-sharp', ...over,
  });

  it('queues renders on window.__runhqEvolve.renders for the SDK to take', async () => {
    const { startEvolveBoot } = await fresh();
    const target: { __runhqEvolve?: EvolveBoot } = {};
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target });
    boot.queueRender(entry());
    expect(target.__runhqEvolve!.renders).toEqual([entry()]);
    expect(boot.rendersTaken()).toBe(false);
  });

  it('pushes into the SDK’s sink once the SDK has taken the queue', async () => {
    const { startEvolveBoot } = await fresh();
    const target: { __runhqEvolve?: EvolveBoot } = {};
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target });
    const sink = { push: vi.fn() };
    (target.__runhqEvolve as { renders: unknown }).renders = sink;
    expect(boot.rendersTaken()).toBe(true);
    boot.queueRender(entry());
    expect(sink.push).toHaveBeenCalledWith(entry());
  });

  it('hands an older SDK each queued render through variation(), for the id it holds only, once', async () => {
    const { startEvolveBoot, flushRendersToOlderSdk } = await fresh();
    const target: { __runhqEvolve?: EvolveBoot } = {};
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(OLD_SHAPE), target });
    await boot.ready;
    boot.queueRender(entry());
    boot.queueRender(entry({ surfaceKey: 'home.closing', defaultPayload: { ctaH1: 'x' }, experimentId: undefined, epoch: undefined, variationId: undefined }));
    boot.queueRender(entry({ surfaceKey: 'home.hero-ko', subjectKey: 'someone-else' }));
    const variation = vi.fn();
    flushRendersToOlderSdk(boot, { variation }, 'anon-1');
    expect(variation.mock.calls).toEqual([
      ['home.hero', { heroH1Line1: 'Shipped.' }],
      ['home.closing', { ctaH1: 'x' }],
    ]);
    flushRendersToOlderSdk(boot, { variation }, 'anon-1');
    expect(variation).toHaveBeenCalledTimes(2);
    expect(target.__runhqEvolve!.renders).toEqual([]);
  });

  it('never hands an older SDK a surface read that painted no arm while a run may be live: its variation() would record an arm nobody saw', async () => {
    const { startEvolveBoot, flushRendersToOlderSdk } = await fresh();
    const declaration = (surfaceKey: string) => entry({ surfaceKey, experimentId: undefined, epoch: undefined, variationId: undefined });
    // Config never arrived (the read timed out): the SDK may well hold a run.
    const failed = startEvolveBoot({ ...ARGS, fetchImpl: respond(null, false), target: {} });
    await failed.ready;
    failed.queueRender(declaration('home.hero'));
    const variation = vi.fn();
    flushRendersToOlderSdk(failed, { variation }, 'anon-1');
    expect(variation).not.toHaveBeenCalled();
    // Config here: a declaration on a surface with a live run is skipped; one with no run is handed over.
    const ok = startEvolveBoot({ ...ARGS, fetchImpl: respond(OLD_SHAPE), target: {} });
    await ok.ready;
    ok.queueRender(declaration('home.hero'));
    ok.queueRender(declaration('home.closing'));
    flushRendersToOlderSdk(ok, { variation }, 'anon-1');
    expect(variation.mock.calls.map((c) => c[0])).toEqual(['home.closing']);
  });

  it('leaves a taken queue to the SDK that took it', async () => {
    const { startEvolveBoot, flushRendersToOlderSdk } = await fresh();
    const target: { __runhqEvolve?: EvolveBoot } = {};
    const boot = startEvolveBoot({ ...ARGS, fetchImpl: respond(NEW_SHAPE), target });
    (target.__runhqEvolve as { renders: unknown }).renders = { push: vi.fn() };
    const variation = vi.fn();
    flushRendersToOlderSdk(boot, { variation }, 'anon-1');
    expect(variation).not.toHaveBeenCalled();
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

describe('renderWhenConfigRead — first render after an already-arrived answer is read', () => {
  function handle(o: { settled?: boolean; arrival?: number | null }) {
    let resolve!: () => void;
    const ready = new Promise<void>((r) => { resolve = r; });
    return {
      boot: { settled: () => o.settled ?? false, arrival: () => o.arrival ?? null, ready } as Pick<EvolveBootHandle, 'settled' | 'arrival' | 'ready'>,
      resolve,
    };
  }

  it('renders at once when there is no boot, it has settled, or nothing has arrived yet (the surfaces wait instead)', async () => {
    const { renderWhenConfigRead } = await fresh();
    for (const boot of [null, handle({ settled: true }).boot, handle({ arrival: null }).boot]) {
      const render = vi.fn();
      renderWhenConfigRead(boot, render, () => 0);
      expect(render).toHaveBeenCalledTimes(1);
    }
  });

  it('when the (preloaded) answer has arrived, first reads it — the few tasks that takes — then renders once', async () => {
    const { renderWhenConfigRead, ARRIVED_READ_GRACE_MS } = await fresh();
    const h = handle({ arrival: 0 });
    const render = vi.fn();
    const timers: Array<[() => void, number]> = [];
    renderWhenConfigRead(h.boot, render, (fn, ms) => { timers.push([fn, ms]); return 0; });
    expect(render).not.toHaveBeenCalled();
    h.resolve();
    await h.boot.ready;
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    timers.forEach(([fn]) => fn());
    expect(render).toHaveBeenCalledTimes(1);
    expect(timers[0][1]).toBe(ARRIVED_READ_GRACE_MS);
  });

  it('never holds the page longer than the grace, whatever the promise does', async () => {
    const { renderWhenConfigRead } = await fresh();
    const h = handle({ arrival: 0 });
    const render = vi.fn();
    let grace!: () => void;
    renderWhenConfigRead(h.boot, render, (fn) => { grace = fn; return 0; });
    grace();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
