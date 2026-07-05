// Google Analytics 4 (gtag.js) bootstrap, gated behind explicit visitor consent.
//
// Two things the raw gtag snippet got wrong are fixed here:
//
//  1. Consent. GA must not fire unconditionally. We initialise Google Consent
//     Mode v2 with every storage type denied by default, and we do not inject
//     the gtag.js script at all until the visitor opts in. Until then no GA
//     cookies are set and no data is sent to Google.
//
//  2. No hardcoded Measurement ID. The ID is injected at build time via
//     VITE_GA_ID so each environment (dev/staging/prod) targets its own GA
//     property. If VITE_GA_ID is unset (e.g. local dev), analytics is disabled.

const GA_ID = import.meta.env.VITE_GA_ID;

export const CONSENT_KEY = 'runhq_analytics_consent';
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

let defaultsSet = false;

// Install the dataLayer/gtag shim and declare Consent Mode defaults (all
// denied). Idempotent — safe to call more than once.
function ensureConsentDefaults() {
  if (defaultsSet) return;
  defaultsSet = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  gtag('js', new Date());
}

let scriptLoaded = false;

// Inject gtag.js and configure the property. Only ever called once consent
// has been granted, so nothing reaches Google before the visitor opts in.
function loadGtagScript() {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);
  gtag('config', GA_ID, { anonymize_ip: true });
}

/**
 * Call once on app start. Activates analytics only if the visitor previously
 * granted consent; otherwise it stays dormant until setAnalyticsConsent(true).
 */
export function initAnalytics() {
  if (!analyticsEnabled()) return;
  ensureConsentDefaults();
  if (storedConsent() === 'granted') {
    gtag('consent', 'update', { analytics_storage: 'granted' });
    loadGtagScript();
  }
}

/** Record the visitor's choice and (de)activate analytics accordingly. */
export function setAnalyticsConsent(granted: boolean) {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    // localStorage may be unavailable — proceed with the in-memory signal.
  }
  if (!analyticsEnabled()) return;
  ensureConsentDefaults();
  if (granted) {
    gtag('consent', 'update', { analytics_storage: 'granted' });
    loadGtagScript();
  } else {
    gtag('consent', 'update', { analytics_storage: 'denied' });
  }
}
