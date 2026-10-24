import { Link, NavLink } from 'react-router-dom';
import { LOGIN_URL } from './chrome';
import { TalkToUsButton } from './TalkToUsModal';
import { trackSignInClick } from '../telemetry';
import { useT, useLocalePath } from '../i18n/context';

/**
 * Nav and footer for the pages in the v10 "self-evolve" design (the homepage
 * and /how-it-works). The other marketing pages still use chrome.tsx.
 *
 * Pages using these must sit inside a `.rhn-root` and include
 * HOME_CHROME_STYLES, which also carries the design's tokens.
 */
const HOME_CHROME_T = {
  en: {
    home: 'RunHQ home',
    howItWorks: 'How it works',
    docs: 'Docs',
    pricing: 'Pricing',
    signIn: 'Sign in',
    contactSales: 'Contact sales',
    manual: 'Manual',
  },
  ko: {
    home: 'RunHQ 홈',
    howItWorks: '작동 방식',
    docs: '문서',
    pricing: '요금제',
    signIn: '로그인',
    contactSales: '영업팀 문의',
    manual: '매뉴얼',
  },
} as const;

/**
 * The public board the marketing pages point to as a working example: ARRR, a
 * voxel pirate game whose players file and vote on tickets that agents build.
 * Served by the `/:slug` board route (BoardPage). Boards are never
 * locale-prefixed (see BoardPage.LocalizedBoardRedirect), so don't wrap it in
 * useLocalePath.
 */
export const SHOWCASE_BOARD_URL = '/arrr';

/**
 * `source` names the page for telemetry. `brand` shows the RunHQ wordmark as a
 * home link; the homepage leaves it off because its hero is the wordmark.
 */
export function HomeNav({ source, brand = false }: { source: string; brand?: boolean }) {
  const t = useT(HOME_CHROME_T);
  const lp = useLocalePath();
  return (
    <nav className="rhn-nav">
      <div className="rhn-nav-group">
        {brand && (
          <Link className="rhn-brand" to={lp('/')} aria-label={t.home}>RunHQ</Link>
        )}
        <NavLink to={lp('/how-it-works')}>{t.howItWorks}</NavLink>
        <Link to={lp('/docs')}>{t.docs}</Link>
        <Link to={lp('/pricing')}>{t.pricing}</Link>
      </div>
      <div className="rhn-nav-group">
        <a href={LOGIN_URL} onClick={() => trackSignInClick(`${source}_nav`)}>{t.signIn}</a>
        <TalkToUsButton className="rhn-start" cta={`${source}_nav`}>{t.contactSales}</TalkToUsButton>
      </div>
    </nav>
  );
}

export function HomeFooter({ source }: { source: string }) {
  const t = useT(HOME_CHROME_T);
  const lp = useLocalePath();
  return (
    <footer className="rhn-foot">
      <span>RunHQ © {new Date().getFullYear()}</span>
      <div>
        <Link to={lp('/how-it-works')}>{t.howItWorks}</Link>
        <Link to={lp('/docs')}>{t.manual}</Link>
        <a href={LOGIN_URL} onClick={() => trackSignInClick(`${source}_footer`)}>{t.signIn}</a>
      </div>
    </footer>
  );
}

export const HOME_CHROME_STYLES = `
  .rhn-root {
    --rhn-bg: #cfcdc6;
    --rhn-ink: #141412;
    --rhn-mute: #5c5b55;
    --rhn-rule: #a9a79f;
    --rhn-serif: 'Instrument Serif', Georgia, serif;
    --rhn-sans: 'Geist', Helvetica, sans-serif;
    --rhn-mono: 'Geist Mono', ui-monospace, monospace;
    --rhn-pad: 48px;
    background: var(--rhn-bg);
    color: var(--rhn-ink);
    font-family: var(--rhn-sans);
    -webkit-font-smoothing: antialiased;
  }
  .rhn-root a { color: inherit; text-decoration: none; }
  .rhn-root a:hover { opacity: .6; }
  .rhn-root em { font-style: italic; }

  .rhn-nav {
    display: flex; justify-content: space-between; align-items: center; gap: 28px;
    padding: 32px var(--rhn-pad);
    font: 400 14px var(--rhn-sans);
    position: relative; z-index: 3;
  }
  .rhn-nav-group { display: flex; align-items: center; gap: 28px; }
  .rhn-root .rhn-brand { font-weight: 600; letter-spacing: -.03em; font-size: 16px; }
  .rhn-nav a[aria-current='page'] { text-decoration: underline; text-underline-offset: 6px; }
  .rhn-root .rhn-start {
    background: var(--rhn-ink); color: var(--rhn-bg);
    padding: 9px 18px; border-radius: 999px;
  }

  .rhn-foot {
    background: var(--rhn-ink); color: #6f6d66;
    display: flex; justify-content: space-between; gap: 24px;
    padding: 28px var(--rhn-pad);
    font: 400 12px var(--rhn-mono); letter-spacing: .04em;
    border-top: 1px solid #2a2a27;
  }
  .rhn-foot > div { display: flex; gap: 28px; }

  @media (prefers-reduced-motion: reduce) {
    .rhn-root *, .rhn-root *::before, .rhn-root *::after { transition: none !important; }
  }

  @media (max-width: 720px) {
    .rhn-root { --rhn-pad: 24px; }
    .rhn-nav { padding-top: 24px; padding-bottom: 24px; gap: 16px; font-size: 13px; }
    .rhn-nav-group { gap: 16px; }
    .rhn-root .rhn-start { padding: 8px 14px; }
    .rhn-foot { flex-wrap: wrap; }
    .rhn-foot > div { gap: 16px; flex-wrap: wrap; }
  }
  @media (max-width: 520px) {
    /* Too narrow for one row: links on top, sign-in and the CTA below. */
    .rhn-nav { flex-wrap: wrap; row-gap: 14px; }
  }
`;
