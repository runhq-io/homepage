import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TELEMETRY_ENV,
  TRACKING_PROJECT,
  clearTelemetryIdentifiers,
  resolveTelemetryEnv,
  trackerTagAttributes,
  widgetInitOptions,
} from './telemetry';

/**
 * What RunHQ records about a visitor to its own site. Two things are worth
 * locking down here, because both have already gone wrong in production once —
 * for GA, in the commits this work follows:
 *
 *  1. Staging must not report as production. The SDK's own default when an
 *     embed says nothing is "production", so the fallback path matters as much
 *     as the explicit one.
 *  2. Nothing may be recorded before the visitor accepts. The tracker's id is a
 *     real cookie, so consent is the whole basis on which the consent bar's
 *     copy ("no cookies are set") is true.
 *
 * And one that is new: the site's traffic goes to its own project,
 * `runhq-homepage`, never to the widget's.
 */

const PROD_API = 'https://console.runhq.io';
const STAGING_API = 'https://console-staging.runhq.io';

describe('resolveTelemetryEnv', () => {
  it('takes an explicitly declared environment', () => {
    expect(resolveTelemetryEnv('staging', PROD_API, true)).toBe('staging');
    expect(resolveTelemetryEnv('development', PROD_API, true)).toBe('development');
    expect(resolveTelemetryEnv('production', STAGING_API, true)).toBe('production');
  });

  it('tolerates the whitespace and casing a CI variable arrives with', () => {
    expect(resolveTelemetryEnv('  Staging \n', PROD_API, true)).toBe('staging');
  });

  /**
   * The point of the fallback: a forgotten VITE_RUNHQ_ENV must not be the thing
   * that puts staging traffic in the production numbers. CI sets the API host
   * per environment, so that is what it is read off.
   */
  it('infers staging from the API host when nobody declared one', () => {
    expect(resolveTelemetryEnv(undefined, STAGING_API, true)).toBe('staging');
    expect(resolveTelemetryEnv('', STAGING_API, true)).toBe('staging');
  });

  it('only says production for a production build against the production API', () => {
    expect(resolveTelemetryEnv(undefined, PROD_API, true)).toBe('production');
  });

  it('keeps non-production builds (local dev, tests) out of real data', () => {
    expect(resolveTelemetryEnv(undefined, PROD_API, false)).toBe('development');
    // Even a stray declared value cannot promote a dev build... unless it is
    // deliberate and valid, which is the documented escape hatch.
    expect(resolveTelemetryEnv('nonsense', PROD_API, false)).toBe('development');
  });
});

describe('widgetInitOptions', () => {
  /**
   * init() would start the tracker against the widget's own project and pin it
   * for the page — `runhq` on the launcher, a customer's on `/:slug`. Neither
   * is where the site's traffic belongs.
   */
  it('never lets the widget track, on either surface', () => {
    expect(widgetInitOptions({ project: 'runhq' })).toEqual({
      project: 'runhq',
      useCookieAuth: true,
      track: false,
    });
    expect(widgetInitOptions({ project: 'arrr', standalone: true })).toEqual({
      project: 'arrr',
      useCookieAuth: true,
      track: false,
      standalone: true,
    });
  });

  it('never sends standalone on the launcher, which would take over the page', () => {
    expect(widgetInitOptions({ project: 'runhq' })).not.toHaveProperty('standalone');
  });
});

describe('trackerTagAttributes', () => {
  it('starts the tracker for runhq-homepage, with the environment, once accepted', () => {
    expect(TRACKING_PROJECT).toBe('runhq-homepage');
    expect(trackerTagAttributes('granted')).toEqual({
      'data-project': 'runhq-homepage',
      'data-track-only': 'true',
      'data-environment': TELEMETRY_ENV,
    });
  });

  it('starts nothing before the visitor accepts, or after they decline', () => {
    expect(trackerTagAttributes(null)).toBeNull();
    expect(trackerTagAttributes('denied')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The consent gate, exercised against a stand-in SDK.
// ---------------------------------------------------------------------------

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    has: (k: string) => data.has(k),
  };
}

type FakeSdk = Record<'init' | 'identify' | 'stage' | 'track', ReturnType<typeof vi.fn>>;

function fakeSdk(): FakeSdk {
  return { init: vi.fn(), identify: vi.fn(), stage: vi.fn(), track: vi.fn() };
}

/**
 * A page where the widget's script has already loaded (the launcher is up),
 * plus just enough DOM for telemetry to inject the tracking-only tag. The
 * injected tag is captured so a test can play the browser and "load" it.
 */
function setup(consent: 'granted' | 'denied' | null) {
  const store = fakeStorage(consent ? { runhq_analytics_consent: consent } : {});
  const widget = fakeSdk();
  const injected: Array<{ attrs: Record<string, string>; load: () => void }> = [];
  const win: { RunHQWidget?: unknown; location: { hostname: string } } = {
    RunHQWidget: widget,
    location: { hostname: 'www.runhq.io' },
  };
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    querySelector: () => ({}),
    createElement: () => {
      const attrs: Record<string, string> = {};
      const listeners: Record<string, () => void> = {};
      const el = {
        dataset: {} as Record<string, string>,
        setAttribute: (k: string, v: string) => void (attrs[k] = v),
        addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
      };
      injected.push({ attrs, load: () => listeners.load?.() });
      return el;
    },
    body: { appendChild: () => undefined },
  });

  /** The browser runs the injected tag: it replaces the global, then fires load. */
  const loadTracker = () => {
    const tracker = fakeSdk();
    win.RunHQWidget = tracker;
    injected[injected.length - 1].load();
    return tracker;
  };
  return { widget, store, win, injected, loadTracker };
}

// telemetry.ts keeps the running tracker in module state, as a page would.
let t: typeof import('./telemetry');
beforeEach(async () => {
  vi.resetModules();
  t = await import('./telemetry');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telemetry emitters', () => {
  it('records nothing at all before the visitor has chosen', () => {
    const { widget, injected } = setup(null);
    t.identifyUser('someone@example.com');
    t.trackEvent('talk_to_us_opened', { cta: 'nav' });
    t.trackSignupClick('pricing_plan', { plan: 'pro' });
    expect(injected).toHaveLength(0);
    expect(widget.identify).not.toHaveBeenCalled();
    expect(widget.track).not.toHaveBeenCalled();
  });

  it('records nothing after a visitor declines', () => {
    const { widget, injected } = setup('denied');
    t.identifyUser('someone@example.com');
    t.startTracking();
    expect(injected).toHaveLength(0);
    expect(widget.identify).not.toHaveBeenCalled();
  });

  /**
   * The visitor accepts with the launcher already on the page. The SDK only
   * reads tracking-only mode at load, so a tracking-only copy is loaded — and
   * everything must go to it, never to the widget's instance, whose project is
   * the `runhq` board.
   */
  it('starts a runhq-homepage tracker on accept and records into it', () => {
    const { widget, injected, loadTracker } = setup('granted');
    t.startTracking();
    expect(injected).toHaveLength(1);
    expect(injected[0].attrs).toEqual({
      'data-project': 'runhq-homepage',
      'data-track-only': 'true',
      'data-environment': TELEMETRY_ENV,
    });

    const tracker = loadTracker();
    t.identifyUser('someone@example.com', { source: 'talk_to_us' });
    t.trackEvent('talk_to_us_opened', { cta: 'nav' });

    expect(tracker.identify).toHaveBeenCalledWith('someone@example.com', { source: 'talk_to_us' });
    expect(tracker.track).toHaveBeenCalledWith('talk_to_us_opened', { cta: 'nav' });
    expect(widget.identify).not.toHaveBeenCalled();
    expect(widget.track).not.toHaveBeenCalled();
  });

  /** The mounted widget re-enters through the global; the copy must not keep it. */
  it('hands the RunHQWidget global back to the widget', () => {
    const { widget, win, loadTracker } = setup('granted');
    t.startTracking();
    loadTracker();
    expect(win.RunHQWidget).toBe(widget);
  });

  it('loads the tracker once, however often it is asked', () => {
    const { injected, loadTracker } = setup('granted');
    t.startTracking();
    t.startTracking();
    t.trackEvent('a');
    loadTracker();
    t.startTracking();
    t.trackEvent('b');
    expect(injected).toHaveLength(1);
  });

  /**
   * The lead is the only moment this site learns who somebody is, and a
   * visitor can submit before the tracker's script has loaded. Email is the
   * identity because it is the key the lead lands under in the admin panel.
   */
  it('holds a lead submitted before the tracker loaded, then joins it', () => {
    const { loadTracker } = setup('granted');
    t.identifyLead({
      name: 'Ada',
      email: '  Ada@Example.COM ',
      website: 'example.com',
      communitySize: '5000',
      monthlyRevenue: '',
    });
    const tracker = loadTracker();

    expect(tracker.identify).toHaveBeenCalledWith('ada@example.com', {
      email: 'ada@example.com',
      name: 'Ada',
      website: 'example.com',
      source: 'talk_to_us',
      community_size: '5000',
    });
    expect(tracker.stage).toHaveBeenCalledWith('lead');
    expect(tracker.track).toHaveBeenCalledWith('lead_submitted', {
      source: 'talk_to_us',
      website: 'example.com',
    });
  });

  it('marks a signup click as funnel progress, a sign-in as not', () => {
    const { loadTracker } = setup('granted');
    t.startTracking();
    const tracker = loadTracker();
    t.trackSignupClick('pricing_plan', { plan: 'pro' });
    t.trackSignInClick('nav');
    expect(tracker.stage).toHaveBeenCalledTimes(1);
    expect(tracker.stage).toHaveBeenCalledWith('signup_started');
    expect(tracker.track).toHaveBeenCalledWith('signup_click', { source: 'pricing_plan', plan: 'pro' });
    expect(tracker.track).toHaveBeenCalledWith('sign_in_click', { source: 'nav' });
  });

  it('survives an SDK that predates the tracking half', () => {
    const { win, injected } = setup('granted');
    t.startTracking();
    win.RunHQWidget = { init: vi.fn() };
    injected[0].load();
    expect(() => t.identifyLead({ name: 'Ada', email: 'a@b.co', website: 'b.co' })).not.toThrow();
  });
});

describe('clearTelemetryIdentifiers', () => {
  /**
   * The widget tracked everyone before consent gated it, so a returning
   * visitor can be carrying an id they never agreed to. Declining takes it
   * away rather than merely stopping new writes.
   */
  it('drops the tracker ids a declining visitor may already carry', () => {
    const { store } = setup('denied');
    store.setItem('rw_anon_id', 'abc123');
    store.setItem('rw_first_touch', '{"url":"https://www.runhq.io/"}');
    vi.stubGlobal('sessionStorage', fakeStorage({ rw_ref: 'someone' }));
    vi.stubGlobal('document', { cookie: '' });

    clearTelemetryIdentifiers();

    expect(store.has('rw_anon_id')).toBe(false);
    expect(store.has('rw_first_touch')).toBe(false);
  });

  it('does not throw where storage is unavailable (private mode)', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('document', undefined);
    expect(() => clearTelemetryIdentifiers()).not.toThrow();
  });
});
