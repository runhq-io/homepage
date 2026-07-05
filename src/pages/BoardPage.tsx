import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import NotFoundPage from './NotFoundPage';

/**
 * Full-page RunHQ widget board, served at `www.runhq.io/:slug`.
 *
 * This replaces the old console-hosted standalone page (`console.runhq.io/w/:slug`,
 * now 301-redirected here). It is a deliberately dumb loader: it injects the
 * canonical `widget.js` from the API host and hands the slug to
 * `RunHQWidget.init` in standalone + cookie-auth mode. Identity comes from the
 * visitor's own `rw_session` cookie (RunHQ member) or falls back to the public
 * view — see docs/superpowers/specs/2026-07-05-www-widget-board-design.md.
 *
 * `www.runhq.io` and the API host (`console.runhq.io`) are same-SITE, so the
 * host-only `rw_session` cookie flows on the widget's cross-origin credentialed
 * calls; the API recognises members via its first-party-origin auth branch.
 */

// The API/script origin. Baked per-env by CI (`console.runhq.io` for prod,
// `console-staging.runhq.io` for staging); falls back to prod.
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '')
  || 'https://console.runhq.io';

// Top-level paths owned by the marketing site (and a few structural names). A
// project slug can never shadow these — react-router already routes declared
// paths to their pages before this catch-all, but this set is the single source
// of truth and a hard backstop. Keep in sync when adding a marketing route.
const RESERVED_SLUGS = new Set([
  'products', 'pricing', 'docs', 'visual', 'about', 'privacy', 'terms',
  'ko', 'api', 'w', 'assets', 'images', 'robots.txt', 'favicon.svg', 'favicon.ico',
]);

declare global {
  interface Window {
    RunHQWidget?: { init: (opts: Record<string, unknown>) => void };
  }
}

export default function BoardPage() {
  const { slug = '' } = useParams();
  // Guard against React 18 StrictMode's double-invoke and slug changes mounting
  // the widget twice.
  const initedForSlug = useRef<string | null>(null);

  const reserved = RESERVED_SLUGS.has(slug.toLowerCase());

  useEffect(() => {
    if (reserved || !slug) return;
    if (initedForSlug.current === slug) return;
    initedForSlug.current = slug;

    document.title = 'RunHQ';
    // Full-bleed dark canvas for the board; the marketing chrome/scroll is not
    // wanted here.
    const prevBodyBg = document.body.style.background;
    const prevHtmlBg = document.documentElement.style.background;
    document.body.style.background = '#0b0b0f';
    document.documentElement.style.background = '#0b0b0f';

    // noindex — shareable boards should not enter search results.
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);

    const start = () => {
      try {
        window.RunHQWidget?.init({ project: slug, standalone: true, useCookieAuth: true });
      } catch {
        /* init is idempotent; a redundant call is a no-op */
      }
    };

    // Reuse an already-loaded widget script (SPA navigation between boards);
    // otherwise inject it once.
    let script = document.querySelector<HTMLScriptElement>('script[data-runhq-widget]');
    if (window.RunHQWidget) {
      start();
    } else if (script) {
      script.addEventListener('load', start, { once: true });
    } else {
      script = document.createElement('script');
      script.src = `${API_BASE}/widget.js`;
      script.async = true;
      script.dataset.runhqWidget = 'true';
      script.addEventListener('load', start, { once: true });
      document.body.appendChild(script);
    }

    return () => {
      document.body.style.background = prevBodyBg;
      document.documentElement.style.background = prevHtmlBg;
      robots.remove();
    };
  }, [slug, reserved]);

  if (reserved) return <NotFoundPage />;

  // The widget mounts itself into the page (shadow-DOM host it creates on init);
  // this is just the full-viewport backdrop it paints over.
  return (
    <div
      id="runhq-board-root"
      style={{ minHeight: '100vh', background: '#0b0b0f' }}
      aria-busy="true"
    />
  );
}
