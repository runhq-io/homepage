/**
 * Shared config + helpers for embedding the RunHQ widget on the marketing site.
 *
 * Two integration surfaces consume this:
 *   - `RunHQWidget` (components/RunHQWidget.tsx): the floating launcher bubble
 *     mounted on every marketing page so visitors (and recognised RunHQ members)
 *     can file RunHQ bugs against the `runhq` board.
 *   - `BoardPage` (pages/BoardPage.tsx): the full-page standalone board served at
 *     `www.runhq.io/:slug`.
 *
 * Both load the same canonical `widget.js` from the API host and share the
 * single-widget-per-page contract the script enforces (`<runhq-widget-host>` is
 * the source of truth; a second `init()` while one is mounted is ignored). This
 * module is the single source of truth for the API origin and the reserved-slug
 * set so the two surfaces can never drift apart.
 */

// The API/script origin. Baked per-env by CI (`console.runhq.io` for prod,
// `console-staging.runhq.io` for staging); falls back to prod.
export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ||
  'https://console.runhq.io';

// The RunHQ-on-RunHQ project: the board where RunHQ's own users file RunHQ bugs.
// Its board lives at `www.runhq.io/runhq`; the marketing-site launcher points at
// the same slug. The project's `allowed_origins` must include `www.runhq.io`
// (and `staging.runhq.io`) for cookie-auth member recognition to succeed —
// otherwise the widget degrades gracefully to the public/anonymous board.
export const RUNHQ_PROJECT = 'runhq';

// Top-level paths owned by the marketing site (and a few structural names). A
// project slug can never shadow these — react-router routes declared paths to
// their pages before the `/:slug` board catch-all, but this set is the single
// source of truth and a hard backstop. Keep in sync when adding a marketing
// route. Mirrors the routes declared in App.tsx.
//
// `ko` is deliberately absent: the locale is no longer a path prefix (see
// i18n/context), so nothing but the legacy `/ko/*` redirect claims that segment.
// Reserving it would make `isBoardRoute('/ko/arrr')` false, the launcher would
// grab the page's single widget slot during the render before that redirect
// commits, and the board's own `init()` would lose to the widget script's
// `initInFlight` guard — a blank board.
export const RESERVED_SLUGS = new Set([
  'products', 'pricing', 'docs', 'visual', 'about', 'privacy', 'terms',
  'api', 'w', 'assets', 'images', 'robots.txt', 'favicon.svg', 'favicon.ico',
]);

/**
 * True when `pathname` resolves to the full-page widget board (`/:slug` and its
 * per-tab sub-paths `/:slug/tickets`, `/:slug/deploys`, `/:slug/my-tickets`)
 * rather than a marketing page. The board route is any path whose first segment
 * is a non-empty, non-reserved slug — reserved first segments (`docs`, `pricing`,
 * …) are the declared marketing routes and their descendants. The board owns the
 * page's single widget instance on every one of these paths, so the floating
 * launcher stays out across tab navigation too.
 */
export function isBoardRoute(pathname: string): boolean {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length === 0 || segments[0] === '') return false;
  return !RESERVED_SLUGS.has(segments[0].toLowerCase());
}

declare global {
  interface Window {
    RunHQWidget?: { init: (opts: Record<string, unknown>) => void };
  }
}

/**
 * Ensure the canonical `widget.js` is present, then run `onReady` once the
 * `RunHQWidget` global is available. Idempotent and shared across both embed
 * surfaces: a single `<script data-runhq-widget>` tag is injected for the whole
 * SPA session and reused on subsequent calls (SPA navigation, re-mounts).
 *
 * The tag carries no `data-project`, so the script's declarative auto-init is a
 * no-op — the caller drives `RunHQWidget.init(...)` with the mode it wants
 * (floating launcher vs. standalone board).
 */
export function loadWidgetScript(onReady: () => void): void {
  if (window.RunHQWidget) {
    onReady();
    return;
  }
  const existing = document.querySelector<HTMLScriptElement>('script[data-runhq-widget]');
  if (existing) {
    existing.addEventListener('load', onReady, { once: true });
    return;
  }
  const script = document.createElement('script');
  script.src = `${API_BASE}/widget.js`;
  script.async = true;
  script.dataset.runhqWidget = 'true';
  script.addEventListener('load', onReady, { once: true });
  document.body.appendChild(script);
}

/**
 * Remove the mounted widget's host element, releasing the single-widget slot so
 * the other embed surface can `init()` fresh. This is exactly the DOM half of
 * the script's internal teardown; the script treats host-absence as "may
 * re-init" (see its idempotency guard), so this is a supported handoff.
 *
 * CAVEAT: it only releases a *settled* instance. The script's guard is
 * `initInFlight || document.querySelector('runhq-widget-host')`, and nothing a
 * host page can call clears `initInFlight` — so an `init()` issued inside
 * another surface's async init gap is still dropped with an "already mounted"
 * warning. Callers must therefore never let both surfaces init for the same
 * navigation; `isBoardRoute` is what keeps the launcher out of the board's way.
 * Closing the race properly means letting a fresh `init()` supersede an
 * in-flight one, which is a change to `be/public/widget.js`.
 */
export function removeWidgetHost(): void {
  document.querySelector('runhq-widget-host')?.remove();
}
