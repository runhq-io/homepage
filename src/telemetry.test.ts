import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TELEMETRY_ENV,
  clearTelemetryIdentifiers,
  identifyLead,
  identifyUser,
  resolveTelemetryEnv,
  shouldTrack,
  trackEvent,
  trackSignupClick,
  widgetInitOptions,
} from './telemetry';
import { launcherAction } from './components/RunHQWidget';

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

describe('shouldTrack', () => {
  it('tracks a marketing page only once the visitor has accepted', () => {
    expect(shouldTrack('granted', 'marketing')).toBe(true);
    expect(shouldTrack('denied', 'marketing')).toBe(false);
    expect(shouldTrack(null, 'marketing')).toBe(false);
  });

  /**
   * The board belongs to whichever project the visitor asked for. The SDK's
   * tracker pins the project it was init'd with for the lifetime of the page,
   * so tracking here wrote RunHQ's own marketing page views into a customer's
   * analytics as soon as the visitor clicked through to /pricing.
   */
  it('never tracks on a board route, however the visitor answered', () => {
    expect(shouldTrack('granted', 'board')).toBe(false);
    expect(shouldTrack('denied', 'board')).toBe(false);
    expect(shouldTrack(null, 'board')).toBe(false);
  });
});

describe('widgetInitOptions', () => {
  it('declares tracking and environment explicitly on the marketing launcher', () => {
    expect(widgetInitOptions({ project: 'runhq', surface: 'marketing', consent: 'granted' })).toEqual({
      project: 'runhq',
      useCookieAuth: true,
      track: true,
      environment: TELEMETRY_ENV,
    });
  });

  it('mounts the board standalone with tracking off', () => {
    expect(
      widgetInitOptions({ project: 'arrr', surface: 'board', consent: 'granted', standalone: true }),
    ).toEqual({
      project: 'arrr',
      useCookieAuth: true,
      track: false,
      standalone: true,
      environment: TELEMETRY_ENV,
    });
  });

  it('never sends standalone on the launcher, which would take over the page', () => {
    const opts = widgetInitOptions({ project: 'runhq', surface: 'marketing', consent: null });
    expect(opts).not.toHaveProperty('standalone');
    expect(opts.track).toBe(false);
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

/** Installs a consent choice plus a stand-in `window.RunHQWidget`. */
function setup(consent: 'granted' | 'denied' | null) {
  const store = fakeStorage(consent ? { runhq_analytics_consent: consent } : {});
  const sdk = {
    init: vi.fn(),
    identify: vi.fn(),
    stage: vi.fn(),
    track: vi.fn(),
  };
  vi.stubGlobal('localStorage', store);
  // `loadWidgetScript` short-circuits to its callback when the global is
  // already there, so nothing here touches the DOM.
  vi.stubGlobal('window', { RunHQWidget: sdk, location: { hostname: 'www.runhq.io' } });
  return { sdk, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telemetry emitters', () => {
  it('records nothing at all before the visitor has chosen', () => {
    const { sdk } = setup(null);
    identifyUser('someone@example.com');
    trackEvent('talk_to_us_opened', { cta: 'nav' });
    trackSignupClick('pricing_plan', { plan: 'pro' });
    expect(sdk.identify).not.toHaveBeenCalled();
    expect(sdk.track).not.toHaveBeenCalled();
    expect(sdk.stage).not.toHaveBeenCalled();
  });

  it('records nothing after a visitor declines', () => {
    const { sdk } = setup('denied');
    identifyUser('someone@example.com');
    trackEvent('talk_to_us_opened');
    expect(sdk.identify).not.toHaveBeenCalled();
    expect(sdk.track).not.toHaveBeenCalled();
  });

  it('identifies and records once the visitor has accepted', () => {
    const { sdk } = setup('granted');
    identifyUser('someone@example.com', { source: 'talk_to_us' });
    trackEvent('talk_to_us_opened', { cta: 'nav' });
    expect(sdk.identify).toHaveBeenCalledWith('someone@example.com', { source: 'talk_to_us' });
    expect(sdk.track).toHaveBeenCalledWith('talk_to_us_opened', { cta: 'nav' });
  });

  /**
   * The lead is the only moment this site learns who somebody is. Email is the
   * identity because it is the key the lead lands under in the admin panel —
   * the same string on both sides is what lets them be matched.
   */
  it('joins a submitted lead to its browsing history', () => {
    const { sdk } = setup('granted');
    identifyLead({
      name: 'Ada',
      email: '  Ada@Example.COM ',
      website: 'example.com',
      communitySize: '5000',
      monthlyRevenue: '',
    });

    expect(sdk.identify).toHaveBeenCalledWith('ada@example.com', {
      email: 'ada@example.com',
      name: 'Ada',
      website: 'example.com',
      source: 'talk_to_us',
      community_size: '5000',
    });
    expect(sdk.stage).toHaveBeenCalledWith('lead');
    expect(sdk.track).toHaveBeenCalledWith('lead_submitted', {
      source: 'talk_to_us',
      website: 'example.com',
    });
  });

  it('marks a signup click as funnel progress, a sign-in as not', () => {
    const { sdk } = setup('granted');
    trackSignupClick('pricing_plan', { plan: 'pro' });
    expect(sdk.stage).toHaveBeenCalledWith('signup_started');
    expect(sdk.track).toHaveBeenCalledWith('signup_click', { source: 'pricing_plan', plan: 'pro' });
  });

  it('survives an SDK that predates the tracking half', () => {
    vi.stubGlobal('localStorage', fakeStorage({ runhq_analytics_consent: 'granted' }));
    vi.stubGlobal('window', { RunHQWidget: { init: vi.fn() } });
    expect(() => identifyLead({ name: 'Ada', email: 'a@b.co', website: 'b.co' })).not.toThrow();
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

// ---------------------------------------------------------------------------
// Applying a tracking decision to the widget that is already on the page.
// ---------------------------------------------------------------------------

describe('launcherAction', () => {
  it('just initialises when nothing of ours is mounted', () => {
    expect(launcherAction(null, false, false)).toBe('init');
    expect(launcherAction(null, false, true)).toBe('init');
    // The board tore our host down and mounted its own; ours is gone, so there
    // is nothing to upgrade and nothing to wait for.
    expect(launcherAction(null, true, true)).toBe('init');
  });

  it('is a no-op init when the mounted widget already has what we want', () => {
    expect(launcherAction(true, true, true)).toBe('init');
    expect(launcherAction(false, true, false)).toBe('init');
  });

  /**
   * The visitor just clicked Accept. The SDK decides tracking once, inside
   * init(), so the only way to start the tracker is to release the host and
   * initialise again.
   */
  it('rebuilds to switch tracking on mid-session', () => {
    expect(launcherAction(false, true, true)).toBe('rebuild');
  });

  /**
   * Accepting during the widget's bootstrap. An init() issued while one is in
   * flight is dropped as a duplicate — rebuilding then would lose the launcher
   * AND never start tracking — so wait for the host to appear.
   */
  it('waits when the instance to rebuild has not mounted yet', () => {
    expect(launcherAction(false, false, true)).toBe('wait');
  });

  /**
   * Withdrawal cannot be applied this way: the SDK latches its tracker for the
   * lifetime of the page, so a rebuild would churn the widget and stop nothing.
   */
  it('does not rebuild to switch tracking off', () => {
    expect(launcherAction(true, true, false)).toBe('init');
  });
});
