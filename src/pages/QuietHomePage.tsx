import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MercuryMark, MERCURY_STYLES, LOGIN_URL } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { trackSignInClick } from '../telemetry';
import { useT, useLocalePath } from '../i18n/context';

/**
 * Preview of a quieter homepage, served at /quiet (and /ko/quiet) for review.
 *
 * The current homepage explains everything. This variant says almost nothing:
 * the mark, one line, one way in. The detail lives on /products, /pricing and
 * /docs for anyone who goes looking. Candidate headlines can be compared with
 * `?h=1`, `?h=2`, `?h=3`.
 *
 * If approved: point `/` and `/ko` at this page in App.tsx, drop the preview
 * switcher and the noindex below, and retire the `quiet` route and reserved slug.
 */
const QUIET_T = {
  en: {
    headlines: [
      'How companies run now.',
      'The company, after agents.',
      'Run the whole company.',
    ],
    line: 'Build, support, sell. One system, run by agents.',
    cta: 'Request access',
    signIn: 'Sign in',
    products: 'Products',
    pricing: 'Pricing',
    docs: 'Docs',
    about: 'About',
    previewLabel: 'Preview headline',
  },
  ko: {
    headlines: [
      '회사가 일하는 새로운 방식.',
      '에이전트 이후의 회사.',
      '회사 전체를 운영하세요.',
    ],
    line: '만들고, 지원하고, 팝니다. 에이전트가 운영하는 하나의 시스템.',
    cta: '접근 요청',
    signIn: '로그인',
    products: '제품',
    pricing: '요금제',
    docs: '문서',
    about: '소개',
    previewLabel: '헤드라인 미리보기',
  },
} as const;

export default function QuietHomePage() {
  const t = useT(QUIET_T);
  const lp = useLocalePath();
  const [params, setParams] = useSearchParams();
  const picked = Number(params.get('h')) - 1;
  const index = picked >= 0 && picked < t.headlines.length ? picked : 0;

  // A preview should not compete with the real homepage in search results.
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    const prevTitle = document.title;
    document.title = 'RunHQ';
    return () => {
      robots.remove();
      document.title = prevTitle;
    };
  }, []);

  return (
    <div className="rhq-root">
      <style>{MERCURY_STYLES}</style>
      <style>{QUIET_STYLES}</style>

      <header className="rhq-top">
        <Link className="rhq-brand" to={lp('/')}>RunHQ</Link>
        <a className="rhq-quiet-link" href={LOGIN_URL} onClick={() => trackSignInClick('quiet_nav')}>
          {t.signIn}
        </a>
      </header>

      <main className="rhq-main">
        <div className="rhq-mark"><MercuryMark size={88} /></div>
        <h1 key={index} className="rhq-h1">{t.headlines[index]}</h1>
        <p className="rhq-line">{t.line}</p>
        <TalkToUsButton className="rhq-cta" cta="quiet_hero">{t.cta}</TalkToUsButton>
      </main>

      <footer className="rhq-foot">
        <nav className="rhq-foot-links">
          <Link to={lp('/products')}>{t.products}</Link>
          <Link to={lp('/pricing')}>{t.pricing}</Link>
          <Link to={lp('/docs')}>{t.docs}</Link>
          <Link to={lp('/about')}>{t.about}</Link>
        </nav>
        <span>© 2026 RunHQ</span>
      </footer>

      <div className="rhq-preview" role="group" aria-label={t.previewLabel}>
        {t.headlines.map((h, i) => (
          <button
            key={h}
            type="button"
            title={h}
            aria-pressed={i === index}
            onClick={() => setParams({ h: String(i + 1) }, { replace: true })}
          >{i + 1}</button>
        ))}
      </div>
    </div>
  );
}

const QUIET_STYLES = `
  .rhq-root {
    --rhq-bg:   #0A0A0C;
    --rhq-ink:  #EDEDF0;
    --rhq-mute: #8A8B93;
    --rhq-faint:#55565E;
    position: relative;
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    background:
      radial-gradient(60% 50% at 50% 42%, rgba(124, 109, 255, 0.10) 0%, transparent 70%),
      var(--rhq-bg);
    color: var(--rhq-ink);
    font-family: 'Geist', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .rhq-root *, .rhq-root *::before, .rhq-root *::after { box-sizing: border-box; }
  .rhq-root a { color: inherit; text-decoration: none; }
  .rhq-root :focus-visible { outline: 2px solid #9D8CFF; outline-offset: 4px; border-radius: 4px; }

  .rhq-top, .rhq-foot {
    display: flex; justify-content: space-between; align-items: center; gap: 24px;
    padding: 28px clamp(20px, 4vw, 48px);
    font-size: 14px;
  }
  /* Centred so the floating bug-report launcher (bottom-left) never covers it. */
  .rhq-foot { justify-content: center; flex-wrap: wrap; column-gap: 24px; row-gap: 10px; }
  .rhq-brand { font-weight: 600; letter-spacing: -0.01em; font-size: 15px; }
  .rhq-quiet-link, .rhq-foot { color: var(--rhq-mute); transition: color 0.2s; }
  .rhq-quiet-link:hover { color: var(--rhq-ink); }

  .rhq-main {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center;
    padding: 0 24px 6vh;
  }
  .rhq-mark { margin-bottom: 48px; animation: rhq-in 1.6s ease both; }
  .rhq-h1 {
    font-size: clamp(40px, 7vw, 96px);
    line-height: 1.02;
    letter-spacing: -0.045em;
    font-weight: 500;
    margin: 0;
    max-width: 14ch;
    text-wrap: balance;
    animation: rhq-in 1.2s 0.25s ease both;
  }
  .rhq-line {
    margin: 28px 0 44px;
    font-size: clamp(16px, 1.4vw, 18px);
    color: var(--rhq-mute);
    letter-spacing: -0.005em;
    animation: rhq-in 1.2s 0.6s ease both;
  }
  .rhq-cta {
    display: inline-flex; align-items: center;
    padding: 12px 24px;
    border-radius: 999px;
    border: 1px solid rgba(237, 237, 240, 0.22);
    font-size: 15px; font-weight: 500;
    transition: background-color 0.2s, color 0.2s, border-color 0.2s;
    animation: rhq-in 1.2s 0.9s ease both;
  }
  .rhq-cta:hover { background: var(--rhq-ink); color: var(--rhq-bg) !important; border-color: var(--rhq-ink); }

  .rhq-foot-links { display: flex; gap: 24px; }
  .rhq-foot-links a:hover { color: var(--rhq-ink); }

  .rhq-preview {
    position: absolute; left: 50%; top: 22px; transform: translateX(-50%);
    display: flex; gap: 4px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    opacity: 0.55;
    transition: opacity 0.2s;
  }
  .rhq-preview:hover, .rhq-preview:focus-within { opacity: 1; }
  .rhq-preview button {
    width: 26px; height: 26px;
    border: 0; border-radius: 50%;
    background: none; color: var(--rhq-mute);
    font: inherit; font-size: 12px;
    cursor: pointer;
  }
  .rhq-preview button[aria-pressed="true"] { background: rgba(255, 255, 255, 0.10); color: var(--rhq-ink); }

  @keyframes rhq-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  @media (max-width: 560px) {
    .rhq-foot-links { gap: 18px; }
    .rhq-foot { padding-bottom: 80px; } /* clear the launcher on narrow screens */
    .rhq-mark { margin-bottom: 36px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rhq-root *, .rhq-root *::before, .rhq-root *::after { animation: none !important; transition: none !important; }
  }
`;
