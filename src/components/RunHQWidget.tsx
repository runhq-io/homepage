import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RUNHQ_PROJECT, isBoardRoute } from '../widget';
import { CONSENT_EVENT, CONSENT_KEY, storedConsent, type ConsentValue } from '../analytics';
import { clearTelemetryIdentifiers, loadSdk, startTracking, widgetInitOptions } from '../telemetry';

/**
 * Mounts the floating RunHQ widget launcher on the marketing site so any
 * visitor — or a recognised RunHQ member — can file RunHQ bugs against the
 * `runhq` board. Rendered once, globally, inside the router (see App.tsx).
 *
 * Identity: `useCookieAuth` lets the visitor's same-site `rw_session` cookie
 * flow on the widget's credentialed calls, so RunHQ members post as themselves
 * and everyone else gets the public/anonymous board — same model as the
 * full-page board (see BoardPage).
 *
 * Telemetry: the widget itself never tracks. This component is where the
 * visitor's consent is applied to the tracker, which records into the separate
 * `runhq-homepage` project — see telemetry.ts.
 *
 * Coexistence with the full-page board: the widget script enforces one instance
 * per page. On a `/:slug` board route BoardPage owns that instance (standalone,
 * full-viewport), so the launcher stays out entirely there. On every other
 * route the launcher owns it. `init()` is idempotent, so marketing→marketing
 * navigation is a no-op that keeps the same bubble mounted.
 */
export default function RunHQWidget() {
  const { pathname } = useLocation();
  const consent = useConsent();

  useEffect(() => {
    // The board route mounts its own standalone widget; yield the single-widget
    // slot to it and don't paint a launcher on top.
    if (isBoardRoute(pathname)) return;

    let cancelled = false;
    loadSdk(() => {
      if (cancelled) return;
      try {
        window.RunHQWidget?.init(widgetInitOptions({ project: RUNHQ_PROJECT }));
      } catch {
        // init() is idempotent — a redundant call (e.g. React 18 StrictMode's
        // double-invoke, or SPA re-navigation) is a no-op.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Accepting starts the tracker without a reload, on any route. A visitor who
  // declines should have the tracker's identifiers taken away, not merely stop
  // accumulating them: the widget tracked everyone before consent gated it, so
  // a returning visitor can be carrying an id they never agreed to.
  useEffect(() => {
    if (consent === 'granted') startTracking();
    if (consent === 'denied') clearTelemetryIdentifiers();
  }, [consent]);

  // The widget injects its own fixed-position shadow-DOM host; nothing to render.
  return null;
}

/**
 * The visitor's stored analytics choice, kept live.
 *
 * Consent decides whether the tracker may run at all, and it can change while
 * the page is open: in this tab (the consent bar, which fires CONSENT_EVENT) or
 * in another one (the native 'storage' event). Re-reading on both is what lets
 * Accept start tracking without a reload.
 */
function useConsent(): ConsentValue | null {
  const [consent, setConsent] = useState<ConsentValue | null>(storedConsent);

  useEffect(() => {
    const sync = () => setConsent(storedConsent());
    // key === null is a storage.clear() — treat it as "might have been ours".
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === CONSENT_KEY) sync();
    };
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return consent;
}
