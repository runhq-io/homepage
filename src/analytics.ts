// Google Analytics 4 (gtag.js) bootstrap, gated behind explicit visitor consent.
//
// Two things the raw gtag snippet got wrong are fixed here:
//
//  1. Consent. GA must not fire unconditionally. Until the visitor opts in we
//     touch nothing: no dataLayer, no gtag stub, no 'js' event, no script. The
//     first thing that ever reaches the dataLayer is the Consent Mode v2
//     defaults (all storage denied), and that only happens at the moment we
//     activate — i.e. once consent is granted. So genuinely nothing reaches
//     Google, and nothing is queued for another tag to process, before opt-in.
//
//  2. Per-environment Measurement ID. VITE_GA_ID is injected at build time so a
//     build can *override* the target GA property (e.g. point staging at its own).
//     A GA4 Measurement ID is not a secret — it ships in cleartext in every page's
//     bundle (and was hardcoded in index.html before analytics moved here) — so a
//     production build falls back to the production property when the env var is
//     absent. That fallback is deliberate: a forgotten CI secret must never again
//     silently black out analytics, the failure that let www.runhq.io/:slug board
//     traffic go completely uncounted. Non-production builds (local dev, tests)
//     stay disabled unless an ID is given explicitly, so they never pollute real
//     analytics.

/** The production GA4 property (public — it ships in the client bundle). */
export const PRODUCTION_GA_ID = 'G-PK433W7S1P';

/**
 * Resolve the GA4 Measurement ID for this build: an explicit VITE_GA_ID always
 * wins; otherwise production builds use {@link PRODUCTION_GA_ID} and non-production
 * builds get none (analytics stays off). Pure so it is unit-testable without
 * rebuilding under different envs.
 */
export function resolveGaId(envId: string | undefined, isProd: boolean): string | undefined {
  if (typeof envId === 'string' && envId.length > 0) return envId;
  return isProd ? PRODUCTION_GA_ID : undefined;
}

const GA_ID = resolveGaId(import.meta.env.VITE_GA_ID, import.meta.env.PROD);

export const CONSENT_KEY = 'runhq_analytics_consent';
// Fired on window whenever the stored consent changes in this tab, so
// same-tab UI (the consent banner, a privacy-page toggle) can react without a
// reload. Cross-tab changes arrive via the native 'storage' event instead.
export const CONSENT_EVENT = 'runhq:consent-change';
export type ConsentValue = 'granted' | 'denied';

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

/** True when a Measurement ID is configured for this build. */
export function analyticsEnabled(): boolean {
  return typeof GA_ID === 'string' && GA_ID.length > 0;
}

/** The visitor's stored choice, or null if they haven't decided yet. */
export function storedConsent(): ConsentValue | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    // localStorage may be unavailable (private mode, etc.).
    return null;
  }
}

function gtag(...args: unknown[]) {
  window.dataLayer.push(args);
}

let activated = false;

// Bring GA online: install the dataLayer/gtag shim, declare Consent Mode
// defaults (all denied), grant analytics storage, then load gtag.js. This is
// the ONLY place that writes to the dataLayer, and it only runs once consent
// has been granted — so nothing is queued before opt-in. Idempotent.
function activate() {
  if (activated || !GA_ID) return;
  activated = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;
  // Consent Mode v2: declare defaults (all denied) and grant analytics storage
  // up front, so the initial page_view is recorded under a granted signal.
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  gtag('consent', 'update', { analytics_storage: 'granted' });
  // Load gtag.js, then push 'js' immediately followed by 'config' — the
  // canonical order documented by Google. These pushes are queued on the
  // dataLayer and replayed in order once the async library finishes loading.
  // (GA4 anonymises IPs by default, so no anonymize_ip flag is needed.)
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
  gtag('js', new Date());
  gtag('config', GA_ID);
}

/**
 * Call once on app start. Activates analytics only if the visitor previously
 * granted consent; otherwise it stays completely dormant (nothing is written
 * to the dataLayer) until setAnalyticsConsent(true).
 */
export function initAnalytics() {
  if (!analyticsEnabled()) return;
  if (storedConsent() === 'granted') activate();
}

/** Record the visitor's choice and (de)activate analytics accordingly. */
export function setAnalyticsConsent(granted: boolean) {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    // localStorage may be unavailable — proceed with the in-memory signal.
  }
  // Notify same-tab listeners (the 'storage' event only fires in other tabs).
  try {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT));
  } catch {
    // CustomEvent may be unavailable in exotic environments — non-fatal.
  }
  if (!analyticsEnabled()) return;
  if (granted) {
    activate();
  } else if (activated) {
    // Only relevant if GA was already brought online earlier this session.
    gtag('consent', 'update', { analytics_storage: 'denied' });
  }
}
