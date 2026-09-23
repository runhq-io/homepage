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

import { RUNHQ_PROJECT, resolveApiBase, widgetScriptUrl } from './apiBase';
import { afterFirstPaint } from './afterFirstPaint';
import { storedConsent } from './analytics';

// The API/script origin. Baked per-env by CI (`console.runhq.io` for prod,
// `console-staging.runhq.io` for staging); falls back to prod. The same rule
// writes the Evolve config preload into index.html (vite.config.ts, apiBase.ts).
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL as string | undefined);

// The RunHQ-on-RunHQ project (defined in apiBase.ts so the build can use it).
// Its board lives at `www.runhq.io/runhq`; the marketing-site launcher points at
// the same slug. The project's `allowed_origins` must include `www.runhq.io`
// (and `staging.runhq.io`) for cookie-auth member recognition to succeed —
// otherwise the widget degrades gracefully to the public/anonymous board.
export { RUNHQ_PROJECT };

// Top-level paths owned by the marketing site (and a few structural names). A
// project slug can never shadow these — react-router routes declared paths to
// their pages before the `/:slug` board catch-all, but this set is the single
// source of truth and a hard backstop. Keep in sync when adding a marketing
// route. Mirrors the routes declared in App.tsx.
export const RESERVED_SLUGS = new Set([
  'products', 'pricing', 'docs', 'visual', 'about', 'privacy', 'terms',
  'ko', 'api', 'w', 'assets', 'images', 'robots.txt', 'favicon.svg', 'favicon.ico',
]);

// Locale prefixes owned by the marketing site. A board URL never carries one,
// but the locale auto-detector used to mint them and visitors shared the result,
// so App.tsx redirects `/ko/<slug>` onto `/<slug>`. That makes `/ko/<slug>` a
// board route *in waiting*, and `isBoardRoute` must say so: the launcher renders
// once before the redirect commits, and if it claims the page's single widget
// slot there, the board's own `init()` loses to the script's `initInFlight`
// guard and the page stays blank. Kept here (not imported from i18n) because
// i18n/context imports `isBoardRoute` — the dependency runs one way.
const LOCALE_PREFIXES = new Set(['ko']);

/**
 * True when `pathname` resolves to the full-page widget board (`/:slug` and its
 * per-tab sub-paths `/:slug/tickets`, `/:slug/deploys`, `/:slug/my-tickets`)
 * rather than a marketing page. The board route is any path whose first
 * meaningful segment is a non-empty, non-reserved slug — reserved segments
 * (`docs`, `ko`, …) are the declared marketing routes and their descendants.
 * The board owns the page's single widget instance on every one of these paths,
 * so the floating launcher stays out across tab navigation too.
 *
 * A leading locale prefix is skipped, because `/ko/<slug>` redirects onto the
 * board (see App.tsx / BoardPage's LocalizedBoardRedirect) and therefore *is* a
 * board route. `/ko` alone, and `/ko/<reserved>`, remain marketing.
 */
export function isBoardRoute(pathname: string): boolean {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  const first = segments[0]?.toLowerCase() ?? '';
  if (!first) return false;
  if (LOCALE_PREFIXES.has(first)) {
    const second = segments[1]?.toLowerCase() ?? '';
    return !!second && !RESERVED_SLUGS.has(second);
  }
  return !RESERVED_SLUGS.has(first);
}

/**
 * The RunHQ SDK's public surface, as far as this site uses it.
 *
 * `widget.js` is one script carrying two products: the feedback widget mounted
 * by `init()`, and the acquisition/CRM tracker behind `identify`/`stage`/
 * `track`. The tracking half is optional on the global (an older cached copy of
 * the script predates it), so every method is declared optional and called with
 * `?.` — see telemetry.ts, which is the only caller.
 */
declare global {
  interface Window {
    RunHQWidget?: {
      init: (opts: Record<string, unknown>) => void;
      /** Join this browser's anonymous id to a known person. */
      identify?: (userId: string, traits?: Record<string, unknown>) => void;
      /** Move the visitor to a named funnel stage. */
      stage?: (stageKey: string) => void;
      /** Record a named event. */
      track?: (name: string, meta?: Record<string, unknown>) => void;
      /** Record revenue against the visitor. */
      revenue?: (amount: number, meta?: Record<string, unknown>) => void;
      /** The variation for an Evolve surface, or `fallback`. Synchronous; reading it IS the exposure. */
      variation?: (surfaceKey: string, fallback: unknown) => unknown;
      /** Resolves once the SDK's variation config has arrived. */
      ready?: () => Promise<void>;
    };
  }
}

/** Callers waiting for the one scheduled insertion. */
const awaitingScript: Array<() => void> = [];
let insertionScheduled = false;

/**
 * Ensure the canonical `widget.js` is present, then run `onReady` once the
 * `RunHQWidget` global is available. Idempotent and shared across every
 * caller: a single `<script data-runhq-widget>` tag is injected for the whole
 * SPA session and reused on subsequent calls (SPA navigation, re-mounts).
 *
 * The tag is inserted AFTER FIRST PAINT (R115), never at boot and never
 * preloaded: nothing the first paint shows depends on the SDK (Evolve copy is
 * decided from the boot config, R114), and its download and parse competed
 * with the app bundle for every visitor's first paint.
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
  awaitingScript.push(onReady);
  if (insertionScheduled) return;
  insertionScheduled = true;
  const insert = () => {
    insertionScheduled = false;
    const waiting = awaitingScript.splice(0);
    const run = () => waiting.forEach((fn) => fn());
    if (window.RunHQWidget) {
      run();
      return;
    }
    const present = document.querySelector<HTMLScriptElement>('script[data-runhq-widget]');
    if (present) {
      present.addEventListener('load', run, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = widgetScriptUrl(API_BASE);
    script.async = true;
    script.dataset.runhqWidget = 'true';
    script.addEventListener('load', run, { once: true });
    document.body.appendChild(script);
  };
  // A visitor who has already consented needs the SDK soon: it is what sends
  // the exposure of the arm they are shown (R126). Everyone else's first paint
  // does not wait on it.
  if (storedConsent() === 'granted') insert();
  else afterFirstPaint(insert);
}

/**
 * Start the SDK at boot for a visitor whose stored consent is `granted`
 * (R126): the sooner it runs, the fewer exposures depend on the page's
 * pagehide beacon. Never preloaded (it would still compete with the app
 * bundle), never on a board (BoardPage loads it for its own project).
 */
export function bootWidgetScriptIfConsented(pathname: string): void {
  try {
    if (isBoardRoute(pathname) || storedConsent() !== 'granted') return;
    loadWidgetScript(() => {});
  } catch {
    // The launcher's own load is the fallback.
  }
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
 * another surface's async init gap is still dropped with a "already mounted"
 * warning. Callers must therefore never let both surfaces init for the same
 * navigation; `isBoardRoute` is what keeps the launcher out of the board's way.
 * Closing the race properly means letting a fresh `init()` supersede an
 * in-flight one, which is a change to `be/public/widget.js`.
 */
export function removeWidgetHost(): void {
  document.querySelector('runhq-widget-host')?.remove();
}
