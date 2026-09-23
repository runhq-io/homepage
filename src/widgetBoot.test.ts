import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, bootWidgetScript, loadWidgetScript } from './widget';
import { resolveApiBase, widgetPreloadTag, widgetScriptUrl } from './apiBase';

/**
 * Ruling R45: the SDK used to be requested only from a component effect, after
 * React mounted, so on a cold load it rarely arrived inside the hero's 400 ms
 * cap and consented first-time visitors were never measured. It is now
 * preloaded from index.html and inserted at boot, before React mounts; the
 * components' later calls reuse that one tag.
 */

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
beforeEach(() => { dom = fakeDom(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('bootWidgetScript', () => {
  it('inserts the SDK script once at boot on a marketing page', () => {
    bootWidgetScript('/');
    expect(dom.appended).toHaveLength(1);
    expect(dom.appended[0]).toMatchObject({ src: widgetScriptUrl(API_BASE), async: true, dataset: { runhqWidget: 'true' } });
    bootWidgetScript('/');
    expect(dom.appended).toHaveLength(1);
  });

  it('makes the component’s later load a no-op that waits on the boot tag', () => {
    bootWidgetScript('/ko');
    const onReady = vi.fn();
    loadWidgetScript(onReady);
    expect(dom.createElement).toHaveBeenCalledTimes(1);
    expect(dom.appended).toHaveLength(1);
    expect(onReady).not.toHaveBeenCalled();
    dom.win.RunHQWidget = { init: () => {} };
    dom.appended[0].fire('load');
    expect(onReady).toHaveBeenCalledTimes(1);
    // Once the global exists, a later caller runs at once and still adds nothing.
    const later = vi.fn();
    loadWidgetScript(later);
    expect(later).toHaveBeenCalledTimes(1);
    expect(dom.appended).toHaveLength(1);
  });

  it('loads nothing at boot on a customer’s board', () => {
    bootWidgetScript('/arrr');
    bootWidgetScript('/ko/arrr');
    bootWidgetScript('/arrr/tickets');
    expect(dom.createElement).not.toHaveBeenCalled();
    expect(dom.appended).toHaveLength(0);
  });

  it('never throws — the page renders whatever the loader does', () => {
    vi.stubGlobal('document', { querySelector: () => { throw new Error('no DOM'); } });
    expect(() => bootWidgetScript('/')).not.toThrow();
  });
});

describe('the preload and the script tag', () => {
  it('preloads the exact URL the loader inserts', () => {
    expect(widgetPreloadTag('https://console-staging.runhq.io')).toEqual({
      tag: 'link',
      attrs: { rel: 'preload', as: 'script', href: 'https://console-staging.runhq.io/widget.js' },
      injectTo: 'head',
    });
    expect(widgetScriptUrl('https://console-staging.runhq.io')).toBe('https://console-staging.runhq.io/widget.js');
  });

  it('agree on the request mode, so the browser reuses the preloaded response', () => {
    // A preload is matched to its consumer by URL AND credentials mode. The
    // loader inserts a classic no-cors <script>; a `crossorigin` preload would
    // be a different request, discarded, and the 850 KB script fetched twice.
    bootWidgetScript('/');
    expect(dom.appended[0].crossOrigin ?? null).toBeNull();
    expect(widgetPreloadTag(API_BASE).attrs).not.toHaveProperty('crossorigin');
  });
});

describe('resolveApiBase', () => {
  it('is the build’s VITE_API_URL without trailing slashes, else production', () => {
    expect(resolveApiBase('https://console-staging.runhq.io/')).toBe('https://console-staging.runhq.io');
    expect(resolveApiBase('https://console-staging.runhq.io')).toBe('https://console-staging.runhq.io');
    expect(resolveApiBase(undefined)).toBe('https://console.runhq.io');
    expect(resolveApiBase('')).toBe('https://console.runhq.io');
  });
});
