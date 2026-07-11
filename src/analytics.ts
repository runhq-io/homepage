// Google Analytics 4 (gtag.js) under Google Consent Mode v2.
//
//  1. Consent Mode, not an on/off switch. gtag.js loads for EVERY visitor, but
//     with all storage denied by default. Under Consent Mode v2 that means GA
//     receives cookieless pings: it can count the visit and model the aggregate,
//     while setting no cookies and storing no client-side identifier. Clicking
//     Accept pushes a `consent update` to granted, which turns on ordinary
//     cookie-based analytics; Decline leaves storage denied, so that visitor
//     stays cookieless forever.
//
//     This replaces an activate-only-after-opt-in design that sent literally
//     nothing — no gtag.js, no ping — until the visitor clicked Accept. Anyone
//     who landed and bounced (i.e. nearly all of a viral traffic spike) was
//     therefore counted as zero, and www.runhq.io/:slug board traffic went
//     unmeasured. Consent Mode is Google's supported answer to exactly that:
//     measure without storing.
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
 * The explicit opt-out value for VITE_GA_ID: a build that deliberately ships with
 * no analytics at all. Staging uses this — see .github/workflows/deploy-staging.yml.
 */
export const GA_DISABLED = 'none';

/**
 * Resolve the GA4 Measurement ID for this build.
 *
 * - An explicit id always wins (per-environment targeting).
 * - The literal {@link GA_DISABLED} means "this build ships without analytics",
 *   and must NOT inherit the production fallback below. Staging needs this: a
 *   staging build is still a *production-mode* vite build, so leaving the var
 *   empty would fall back to the production property and pollute real data with
 *   staging traffic.
 * - Unset/empty means somebody forgot to configure it. That must never again
 *   silently black out production analytics, so production falls back to
 *   {@link PRODUCTION_GA_ID}. Distinguishing "deliberately none" from "forgotten"
 *   is exactly why the sentinel exists rather than just using an empty string.
 * - Non-production builds (local dev, tests) stay off unless given an id.
 *
 * Pure, so it is unit-testable without rebuilding under different envs.
 */
export function resolveGaId(envId: string | undefined, isProd: boolean): string | undefined {
  const declared = typeof envId === 'string' ? envId.trim() : '';
  if (declared.toLowerCase() === GA_DISABLED) return undefined;
  if (declared.length > 0) return declared;
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

function gtagStorage(granted: boolean) {
  return { analytics_storage: granted ? 'granted' : 'denied' } as const;
}

/**
 * The gtag command sequence that brings GA online under Consent Mode v2, in
 * order. Exported and pure because the ORDER is the whole ballgame: the
 * `consent default` must be queued before `config`, or gtag.js will have already
 * decided it may use storage by the time consent arrives.
 *
 * A visitor who opted in on a previous visit is upgraded to granted *before* the
 * first `config`, so their very first page_view of the session is measured with
 * storage granted rather than as a cookieless ping.
 */
export function consentModeCommands(gaId: string, priorConsent: ConsentValue | null): unknown[][] {
  const commands: unknown[][] = [
    [
      'consent',
      'default',
      {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      },
    ],
  ];
  if (priorConsent === 'granted') commands.push(['consent', 'update', gtagStorage(true)]);
  // 'js' then 'config' — the canonical order documented by Google. GA4 anonymises
  // IPs by default, so no anonymize_ip flag is needed.
  commands.push(['js', new Date()]);
  commands.push(['config', gaId]);
  return commands;
}

let booted = false;

/**
 * Load gtag.js under Consent Mode v2 with all storage denied. Runs once for
 * EVERY visitor regardless of consent — denied storage is what makes that
 * privacy-safe: GA gets a cookieless ping it can count and model, and sets no
 * cookies. Idempotent.
 */
function boot() {
  if (booted || !GA_ID) return;
  booted = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;
  // Queue every command before requesting the library. JS is single-threaded, so
  // the async script cannot execute until this block finishes — gtag.js replays
  // the queue in order on load.
  for (const command of consentModeCommands(GA_ID, storedConsent())) {
    window.dataLayer.push(command);
  }
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
}

/**
 * Report a client-side (react-router) navigation as a page_view. The initial
 * hard load is already reported by `config`, so callers must only fire this for
 * navigations that follow — otherwise the landing page is counted twice.
 * No-ops until GA has booted.
 */
export function trackPageview(pagePath: string) {
  if (!booted) return;
  gtag('event', 'page_view', {
    page_path: pagePath,
    page_location: window.location.href,
    page_title: document.title,
  });
}

/**
 * Call once on app start. Brings GA online for every visitor under Consent Mode
 * v2 (storage denied unless they previously opted in), so traffic is measured
 * cookielessly from the first hit instead of being lost until someone clicks
 * Accept.
 */
export function initAnalytics() {
  if (!analyticsEnabled()) return;
  boot();
}

/**
 * Record the visitor's choice and move GA's storage grant to match. Under
 * Consent Mode consent is an upgrade/downgrade, not an on/off switch: GA is
 * already running cookielessly, so Accept grants storage (cookies on) and
 * Decline keeps it denied (the visitor stays a cookieless ping).
 */
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
  // Normally a no-op (initAnalytics booted GA at startup); covers the case where
  // a choice is made before init ran.
  boot();
  gtag('consent', 'update', gtagStorage(granted));
}
