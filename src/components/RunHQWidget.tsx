import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { RUNHQ_PROJECT, isBoardRoute, loadWidgetScript } from '../widget';

/**
 * Mounts the floating RunHQ widget launcher on the marketing site so any
 * visitor — or a recognised RunHQ member — can file RunHQ bugs against the
 * `runhq` board without leaving the page. Rendered once, globally, inside the
 * router (see App.tsx).
 *
 * Identity: `useCookieAuth` lets the visitor's same-site `rw_session` cookie
 * flow on the widget's credentialed calls, so RunHQ members post as themselves
 * and everyone else gets the public/anonymous board — same model as the
 * full-page board (see BoardPage).
 *
 * Coexistence with the full-page board: the widget script enforces one instance
 * per page. On a `/:slug` board route BoardPage owns that instance (standalone,
 * full-viewport), so the launcher stays out entirely there. On every other
 * route the launcher owns it. `init()` is idempotent, so marketing→marketing
 * navigation is a no-op that keeps the same bubble mounted.
 */
export default function RunHQWidget() {
  const { pathname } = useLocation();

  useEffect(() => {
    // The board route mounts its own standalone widget; yield the single-widget
    // slot to it and don't paint a launcher on top.
    if (isBoardRoute(pathname)) return;

    loadWidgetScript(() => {
      try {
        window.RunHQWidget?.init({ project: RUNHQ_PROJECT, useCookieAuth: true });
      } catch {
        // init() is idempotent — a redundant call (e.g. React 18 StrictMode's
        // double-invoke, or SPA re-navigation) is a no-op.
      }
    });
  }, [pathname]);

  // The widget injects its own fixed-position shadow-DOM host; nothing to render.
  return null;
}
