import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R115: the SDK is neither preloaded nor inserted at boot any more. It loaded
 * in parallel with the app bundle and delayed first paint for every visitor —
 * mostly visitors whose first paint never needed it. The copy is decided from
 * the boot config (R114), so the SDK loads after first paint, once, whoever
 * asks for it first.
 */

const scheduled: Array<() => void> = [];
const scheduledOptions: Array<{ idle?: boolean } | undefined> = [];
vi.mock('./afterFirstPaint', () => ({ afterFirstPaint: (fn: () => void, o?: { idle?: boolean }) => { scheduled.push(fn); scheduledOptions.push(o); } }));
let consent: 'granted' | 'denied' | null = null;
vi.mock('./analytics', async (importOriginal) => ({ ...(await importOriginal<object>()), storedConsent: () => consent }));

interface FakeScript {
  src: string;
  async: boolean;
  crossOrigin?: string | null;
  dataset: Record<string, string>;
  addEventListener: (type: string, fn: () => void) => void;
  fire(type: string): void;
}

function fakeDom() {
  const appended: FakeScript[] = [];
  const createElement = vi.fn((): FakeScript => {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      src: '',
      async: false,
      dataset: {},
      addEventListener: vi.fn((type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); }),
      fire(type) { (listeners[type] ?? []).splice(0).forEach((fn) => fn()); },
    };
  });
  const win: { RunHQWidget?: unknown } = {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    createElement,
    querySelector: vi.fn((selector: string) =>
      selector === 'script[data-runhq-widget]' ? appended.find((s) => s.dataset.runhqWidget) ?? null : null),
    body: { appendChild: vi.fn((el: FakeScript) => { appended.push(el); }) },
  });
  return { appended, createElement, win };
}

let dom: ReturnType<typeof fakeDom>;
beforeEach(() => { scheduled.length = 0; scheduledOptions.length = 0; consent = null; dom = fakeDom(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

const load = () => import('./widget');

describe('loadWidgetScript', () => {
  it('inserts nothing before first paint, then the SDK once, for every caller', async () => {
    const { loadWidgetScript, API_BASE } = await load();
    const { widgetScriptUrl } = await import('./apiBase');
    const a = vi.fn();
    const b = vi.fn();
    loadWidgetScript(a);
    loadWidgetScript(b);
    expect(dom.appended).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    scheduled.splice(0).forEach((fn) => fn());
    expect(dom.appended).toHaveLength(1);
    expect(dom.appended[0]).toMatchObject({ src: widgetScriptUrl(API_BASE), async: true, dataset: { runhqWidget: 'true' } });
    // A classic no-cors script, as before.
    expect(dom.appended[0].crossOrigin ?? null).toBeNull();
    expect(a).not.toHaveBeenCalled();
    dom.win.RunHQWidget = { init: () => {} };
    dom.appended[0].fire('load');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a caller after the tag exists waits on it; after the global exists, runs at once', async () => {
    const { loadWidgetScript } = await load();
    loadWidgetScript(() => {});
    scheduled.splice(0).forEach((fn) => fn());
    const later = vi.fn();
    loadWidgetScript(later);
    expect(dom.appended).toHaveLength(1);
    dom.win.RunHQWidget = { init: () => {} };
    dom.appended[0].fire('load');
    expect(later).toHaveBeenCalledTimes(1);
    const now = vi.fn();
    loadWidgetScript(now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(dom.appended).toHaveLength(1);
  });

  it('does not insert a second tag when the SDK arrived another way before the scheduled insert ran', async () => {
    const { loadWidgetScript } = await load();
    const cb = vi.fn();
    loadWidgetScript(cb);
    dom.win.RunHQWidget = { init: () => {} };
    scheduled.splice(0).forEach((fn) => fn());
    expect(dom.appended).toHaveLength(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('a visitor whose stored consent is granted (R126, round-2 re-review I-1)', () => {
  it('gets the SDK right after first paint, without the idle wait — never before first render', async () => {
    consent = 'granted';
    const { loadWidgetScript } = await load();
    loadWidgetScript(() => {});
    // Nothing at call time: starting the SDK during React's first render cost
    // returning consented visitors 2–4 s of hero image (measured).
    expect(dom.appended).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduledOptions[0]).toEqual({ idle: false });
    scheduled.splice(0).forEach((fn) => fn());
    expect(dom.appended).toHaveLength(1);
  });

  it('everyone else waits for first paint AND idle time', async () => {
    const { loadWidgetScript } = await load();
    loadWidgetScript(() => {});
    expect(scheduledOptions[0]).toBeUndefined();
  });

  it('the boot-time insertion is gone', async () => {
    const mod = await load();
    expect((mod as Record<string, unknown>).bootWidgetScriptIfConsented).toBeUndefined();
  });
});

describe('the build’s preload', () => {
  it('preloads the Evolve config — never the SDK — with the exact URL and mode the app fetches', async () => {
    const { evolveConfigPreloadTag, evolveConfigUrl } = await import('./apiBase');
    const { evolveConfigRequestInit } = await import('./evolve/bootConfig');
    expect(evolveConfigPreloadTag('https://console-staging.runhq.io', 'staging')).toEqual({
      tag: 'link',
      attrs: {
        rel: 'preload', as: 'fetch', crossorigin: 'anonymous',
        href: 'https://console-staging.runhq.io/api/widget/evolve/config?project=runhq&environment=staging',
      },
      injectTo: 'head',
    });
    expect(evolveConfigUrl('https://x.test', 'runhq', 'production')).toBe('https://x.test/api/widget/evolve/config?project=runhq&environment=production');
    // crossorigin="anonymous" ⇔ mode cors + credentials same-origin.
    expect(evolveConfigRequestInit).toEqual({ mode: 'cors', credentials: 'same-origin' });
  });
});

describe('resolveApiBase', () => {
  it('is the build’s VITE_API_URL without trailing slashes, else production', async () => {
    const { resolveApiBase } = await import('./apiBase');
    expect(resolveApiBase('https://console-staging.runhq.io/')).toBe('https://console-staging.runhq.io');
    expect(resolveApiBase(undefined)).toBe('https://console.runhq.io');
    expect(resolveApiBase('')).toBe('https://console.runhq.io');
  });
});
