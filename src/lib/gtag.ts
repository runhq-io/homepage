export type GtagEventParams = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

// Console GA4 Measurement ID (public).
// In production we default to the console property ID so GA “just works” if
// the env var isn't explicitly set. In development we only enable GA when
// provided to avoid polluting real analytics data during local dev.
const DEFAULT_GA_MEASUREMENT_ID = 'G-6M20QMDDY2';
const ENV_GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

export const GA_MEASUREMENT_ID: string | undefined =
  process.env.NODE_ENV === 'production' ? (ENV_GA_ID ?? DEFAULT_GA_MEASUREMENT_ID) : ENV_GA_ID;

function ensureGtag() {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer || [];

  // If the init snippet hasn't executed yet, define a compatible stub.
  if (!window.gtag) {
    window.gtag = (...args: unknown[]) => {
      window.dataLayer?.push(args);
    };
  }
}

export function gtag(...args: unknown[]) {
  ensureGtag();
  if (typeof window === 'undefined') return;
  window.gtag?.(...args);
}

export function pageview(pagePath: string) {
  if (typeof window === 'undefined') return;

  gtag('event', 'page_view', {
    page_title: document.title,
    page_location: window.location.href,
    page_path: pagePath,
  });
}

export function trackEvent(eventName: string, params?: GtagEventParams) {
  gtag('event', eventName, params ?? {});
}
