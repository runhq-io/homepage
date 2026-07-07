import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import NotFoundPage from './NotFoundPage';
import { RESERVED_SLUGS, loadWidgetScript, removeWidgetHost } from '../widget';

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
 *
 * `API_BASE`, `RESERVED_SLUGS`, and the widget loader/teardown helpers are
 * shared with the marketing-site floating launcher (see ../widget and
 * components/RunHQWidget) so the two embed surfaces stay in lockstep.
 */

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
      // The full-page board owns the page's single widget instance. If the
      // marketing launcher (or a previous board) already mounted one, release
      // the slot so this standalone init isn't ignored by the script's
      // single-widget guard.
      removeWidgetHost();
      try {
        window.RunHQWidget?.init({ project: slug, standalone: true, useCookieAuth: true });
      } catch {
        /* init is idempotent; a redundant call is a no-op */
      }
    };

    // Reuse an already-loaded widget script (SPA navigation between boards, or a
    // launcher mounted on a marketing page); otherwise inject it once.
    loadWidgetScript(start);

    return () => {
      document.body.style.background = prevBodyBg;
      document.documentElement.style.background = prevHtmlBg;
      robots.remove();
      // Don't leave the standalone board's widget mounted over whatever page the
      // visitor navigates to next (e.g. back to marketing); the launcher there
      // will mount its own instance.
      removeWidgetHost();
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
