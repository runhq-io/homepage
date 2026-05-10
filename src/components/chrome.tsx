import { Link } from 'react-router-dom';

export const SIGNUP_URL = 'https://app.runhq.io/signup';
export const LOGIN_URL = 'https://app.runhq.io';

export const MercuryMark = ({ size = 24 }: { size?: number }) => (
  <span className="rhc-merc" style={{ width: size, height: size }} aria-hidden="true">
    <span className="rhc-merc-halo" />
    <svg width="100%" height="100%" viewBox="0 0 80 80" overflow="visible">
      <defs>
        <filter id="rhc-merc-goo" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.4" />
          <feColorMatrix
            values="1 0 0 0 0
                    0 1 0 0 0
                    0 0 1 0 0
                    0 0 0 24 -11"
          />
        </filter>
        <radialGradient id="rhc-merc-fill" cx="38%" cy="28%" r="80%">
          <stop offset="0%"   stopColor="#ffffff" />
          <stop offset="30%"  stopColor="#f4f0ff" />
          <stop offset="58%"  stopColor="#cfd8ff" />
          <stop offset="82%"  stopColor="#b9aaf0" />
          <stop offset="100%" stopColor="#7d6dc8" />
        </radialGradient>
        <radialGradient id="rhc-merc-spec" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="rgba(255,255,255,1)" />
          <stop offset="60%"  stopColor="rgba(255,255,255,0.45)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <radialGradient id="rhc-merc-cyan" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="rgba(150,210,255,0.55)" />
          <stop offset="100%" stopColor="rgba(150,210,255,0)" />
        </radialGradient>
        <radialGradient id="rhc-merc-violet" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="rgba(180,130,255,0.45)" />
          <stop offset="100%" stopColor="rgba(180,130,255,0)" />
        </radialGradient>
        <clipPath id="rhc-merc-clip" clipPathUnits="userSpaceOnUse">
          <circle cx="40" cy="40" r="22" />
        </clipPath>
      </defs>
      <g filter="url(#rhc-merc-goo)">
        <circle className="rhc-merc-base" cx="40" cy="40" r="18" fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb1" cx="40" cy="40" r="9"   fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb2" cx="40" cy="40" r="8"   fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb3" cx="40" cy="40" r="9.5" fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb4" cx="40" cy="40" r="7.5" fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb5" cx="40" cy="40" r="6.5" fill="url(#rhc-merc-fill)" />
        <circle className="rhc-merc-bulge rhc-mb6" cx="40" cy="40" r="7"   fill="url(#rhc-merc-fill)" />
      </g>
      <g clipPath="url(#rhc-merc-clip)" style={{ mixBlendMode: 'screen' }}>
        <circle className="rhc-merc-tint rhc-merc-cyan-tint" cx="40" cy="40" r="14" fill="url(#rhc-merc-cyan)" />
        <circle className="rhc-merc-tint rhc-merc-violet-tint" cx="40" cy="40" r="14" fill="url(#rhc-merc-violet)" />
      </g>
      <g clipPath="url(#rhc-merc-clip)">
        <circle className="rhc-merc-spec" cx="40" cy="40" r="5" fill="url(#rhc-merc-spec)" />
      </g>
    </svg>
  </span>
);

export const Wordmark = ({ name, size = 14, color = 'currentColor' }: { name: string; size?: number; color?: string }) => (
  <span style={{
    fontFamily: 'Geist, "Inter Tight", system-ui, sans-serif',
    fontWeight: 600,
    fontSize: size,
    letterSpacing: '-0.02em',
    color,
    opacity: 0.78,
    whiteSpace: 'nowrap',
  }}>{name}</span>
);

export const Avatar = ({ name, size = 28, bg }: { name: string; size?: number; bg?: string }) => {
  const initials = name.split(' ').map((s) => s[0]).slice(0, 2).join('');
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: bg || `oklch(0.55 0.10 ${hue})`,
      color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 600,
      letterSpacing: '0.02em',
      flexShrink: 0,
    }}>{initials}</span>
  );
};

const STATUS_MAP: Record<string, { fg: string; bg: string; dot: string; label: string }> = {
  merged:   { fg: '#1f3a2c', bg: '#9bd6b6', dot: '#1c8b50', label: 'Merged' },
  review:   { fg: '#3a3018', bg: '#e8c46a', dot: '#a87f1a', label: 'Review' },
  shipping: { fg: '#2a2030', bg: '#c2a0e6', dot: '#6a3aa8', label: 'Shipping' },
  failed:   { fg: '#3a1c1c', bg: '#e89c9c', dot: '#a83333', label: 'Failed' },
};
export const StatusPill = ({ status }: { status: string }) => {
  const s = STATUS_MAP[status] || STATUS_MAP.review;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 500,
      padding: '3px 9px 3px 7px',
      borderRadius: 999,
      background: s.bg, color: s.fg,
      letterSpacing: '-0.005em',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot }} />
      {s.label}
    </span>
  );
};

const SRC_MAP: Record<string, { color: string; glyph: string }> = {
  intercom: { color: '#3F70F5', glyph: '◐' },
  linear:   { color: '#5E6AD2', glyph: '◢' },
  widget:   { color: '#7DD3C0', glyph: '◉' },
  slack:    { color: '#E01E5A', glyph: '✻' },
  github:   { color: '#888',    glyph: '◇' },
};
export const SourceIcon = ({ src, size = 14 }: { src: string; size?: number }) => {
  const m = SRC_MAP[src] || SRC_MAP.widget;
  return (
    <span style={{
      width: size, height: size, borderRadius: 4,
      background: m.color + '22',
      color: m.color,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.85, lineHeight: 1,
      flexShrink: 0,
    }}>{m.glyph}</span>
  );
};

const AGENT_MAP: Record<string, { color: string; label: string }> = {
  claude: { color: '#D97757', label: 'C' },
  cursor: { color: '#aaaaaa', label: '⌘' },
  codex:  { color: '#10A37F', label: 'X' },
  devin:  { color: '#7DD3C0', label: 'D' },
};
export const AgentIcon = ({ agent, size = 14 }: { agent: string; size?: number }) => {
  const m = AGENT_MAP[agent] || AGENT_MAP.claude;
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: m.color,
      color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.6, fontWeight: 700,
      fontFamily: '"JetBrains Mono", monospace',
      flexShrink: 0,
    }}>{m.label}</span>
  );
};

export const LOGOS = [
  'jeju.com', 'smartbid.ai', 'socialrealtr.com',
];

type NavActive = 'products' | 'pricing' | 'docs' | null;

export function Navbar({ active = null }: { active?: NavActive } = {}) {
  return (
    <header className="rhc-nav">
      <style>{NAV_STYLES}</style>
      <div className="rhc-nav-l">
        <Link className="rhc-brand" to="/">
          <span className="rhc-brand-mark"><MercuryMark size={22} /></span>
          <span className="rhc-brand-name">RunHQ</span>
        </Link>
        <nav className="rhc-nav-c">
          <Link to="/products" className={`rhc-nav-i ${active === 'products' ? 'rhc-nav-on' : ''}`}>Products</Link>
          <Link to="/pricing" className={`rhc-nav-i ${active === 'pricing' ? 'rhc-nav-on' : ''}`}>Pricing</Link>
          <Link to="/docs" className={`rhc-nav-i ${active === 'docs' ? 'rhc-nav-on' : ''}`}>Docs</Link>
        </nav>
      </div>
      <div className="rhc-nav-r">
        <a className="rhc-signin" href={LOGIN_URL}>Sign in</a>
        <a className="rhc-cta" href={SIGNUP_URL}>Start free</a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="rhc-footer">
      <style>{FOOTER_STYLES}</style>
      <div className="rhc-footer-grid">
        <div>
          <div className="rhc-footer-brand">
            <span className="rhc-brand-mark"><MercuryMark size={22} /></span>
            <span>RunHQ</span>
          </div>
          <p className="rhc-footer-blurb">
            The operations layer for AI coding agents. Vancouver, BC.
          </p>
        </div>
        <div>
          <div className="rhc-footer-h">Products</div>
          <Link to="/products">Agent automation</Link>
          <Link to="/products">Project management</Link>
          <Link to="/products">Dev environment</Link>
          <Link to="/products">Feedback widget</Link>
        </div>
        <div>
          <div className="rhc-footer-h">Company</div>
          <Link to="/docs">Docs</Link>
          <Link to="/about">About</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </div>
      <div className="rhc-footer-base">
        <span>© 2026 RunHQ Solutions Inc.</span>
        <span>·</span>
        <span>Closed-loop product development</span>
        <span style={{ marginLeft: 'auto' }}>Built for agent-driven product teams</span>
      </div>
    </footer>
  );
}

const NAV_STYLES = `
  .rhc-nav {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    gap: 18px;
    align-items: center;
    padding: 14px 28px;
    border-bottom: 1px solid var(--rhw-line);
    background: var(--rhw-surface);
    position: sticky; top: 0; z-index: 30;
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
  }
  .rhc-nav *, .rhc-nav *::before, .rhc-nav *::after { box-sizing: border-box; }
  .rhc-nav a { color: inherit; text-decoration: none; }
  .rhc-nav-l { display: contents; }
  .rhc-brand {
    display: inline-flex; align-items: center; gap: 9px;
    font-weight: 600; font-size: 16px; letter-spacing: -0.01em;
    color: var(--rhw-ink);
  }
  .rhc-brand-mark {
    width: 28px; height: 28px; border-radius: 8px;
    background: radial-gradient(120% 140% at 30% 20%, #1d1a2e 0%, #0c0b14 70%);
    box-shadow:
      inset 0 0 0 1px rgba(255,255,255,0.05),
      0 4px 14px -6px rgba(108, 89, 255, 0.45);
    display: inline-flex; align-items: center; justify-content: center;
    overflow: visible;
    position: relative;
  }
  .rhc-brand:hover .rhc-merc { filter: drop-shadow(0 2px 8px rgba(124, 109, 255, 0.7)); }

  /* ================================================================
     Mercury — liquid-metal brand mark
     Base + 6 perimeter-traveling bulges share an SVG goo filter for a
     silhouette that ripples like mercury. Iridescent oil-slick rim,
     inner roaming specular, and a breathing halo finish the organism.
     ================================================================ */
  .rhc-merc {
    position: relative;
    display: inline-block;
    flex: 0 0 auto;
    filter: drop-shadow(0 2px 6px rgba(108, 89, 255, 0.45));
    transition: filter 0.3s ease;
  }
  .rhc-merc svg { display: block; overflow: visible; position: relative; z-index: 1; }
  .rhc-merc-halo {
    position: absolute;
    inset: -55%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(180,165,255,0.45) 0%, rgba(180,165,255,0.12) 40%, transparent 65%);
    animation: rhc-merc-halo-breath 4.8s ease-in-out infinite;
    pointer-events: none;
    z-index: 0;
  }
  @keyframes rhc-merc-halo-breath {
    0%, 100% { opacity: 0.65; transform: scale(0.95); }
    50%      { opacity: 1;    transform: scale(1.15); }
  }
  .rhc-merc-base {
    transform-origin: 40px 40px;
    animation: rhc-merc-base-breath 5.4s ease-in-out infinite;
  }
  @keyframes rhc-merc-base-breath {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.05); }
  }
  .rhc-merc-bulge { transform-origin: 40px 40px; }
  .rhc-mb1 { animation: rhc-mb-a 3.6s ease-in-out infinite; }
  .rhc-mb2 { animation: rhc-mb-b 4.4s ease-in-out infinite; }
  .rhc-mb3 { animation: rhc-mb-c 3.2s ease-in-out infinite; }
  .rhc-mb4 { animation: rhc-mb-d 4.0s ease-in-out infinite; }
  .rhc-mb5 { animation: rhc-mb-e 3.8s ease-in-out infinite; }
  .rhc-mb6 { animation: rhc-mb-f 4.6s ease-in-out infinite; }
  @keyframes rhc-mb-a {
    0%   { transform: translate(20px, -2px)   scale(1.15); }
    25%  { transform: translate(14px, 15px)   scale(0.95); }
    50%  { transform: translate(-17px, 11px)  scale(1.2); }
    75%  { transform: translate(-13px, -16px) scale(0.9); }
    100% { transform: translate(20px, -2px)   scale(1.15); }
  }
  @keyframes rhc-mb-b {
    0%   { transform: translate(-18px, 10px) scale(1.0); }
    33%  { transform: translate(10px, -18px) scale(1.25); }
    66%  { transform: translate(17px, 14px)  scale(0.85); }
    100% { transform: translate(-18px, 10px) scale(1.0); }
  }
  @keyframes rhc-mb-c {
    0%   { transform: translate(2px, -20px)  scale(1.1); }
    25%  { transform: translate(18px, -9px)  scale(0.9); }
    50%  { transform: translate(11px, 18px)  scale(1.2); }
    75%  { transform: translate(-19px, 6px)  scale(1.0); }
    100% { transform: translate(2px, -20px)  scale(1.1); }
  }
  @keyframes rhc-mb-d {
    0%   { transform: translate(15px, -11px) scale(1.05); }
    33%  { transform: translate(-15px, -10px) scale(1.15); }
    66%  { transform: translate(3px, 19px)   scale(0.95); }
    100% { transform: translate(15px, -11px) scale(1.05); }
  }
  @keyframes rhc-mb-e {
    0%   { transform: translate(-9px, -17px) scale(1.0); }
    50%  { transform: translate(9px, 17px)   scale(1.15); }
    100% { transform: translate(-9px, -17px) scale(1.0); }
  }
  @keyframes rhc-mb-f {
    0%   { transform: translate(17px, 9px)   scale(0.95); }
    50%  { transform: translate(-17px, -9px) scale(1.2); }
    100% { transform: translate(17px, 9px)   scale(0.95); }
  }
  .rhc-merc-tint { transform-origin: 40px 40px; }
  .rhc-merc-cyan-tint   { animation: rhc-merc-cyan-drift   7.2s ease-in-out infinite; }
  .rhc-merc-violet-tint { animation: rhc-merc-violet-drift 7.2s ease-in-out infinite; }
  @keyframes rhc-merc-cyan-drift {
    0%   { transform: translate(-8px, -6px); }
    50%  { transform: translate(8px, 6px); }
    100% { transform: translate(-8px, -6px); }
  }
  @keyframes rhc-merc-violet-drift {
    0%   { transform: translate(8px, 6px); }
    50%  { transform: translate(-8px, -6px); }
    100% { transform: translate(8px, 6px); }
  }
  .rhc-merc-spec {
    transform-origin: 40px 40px;
    animation: rhc-merc-spec-drift 6.4s ease-in-out infinite;
    filter: blur(0.4px);
  }
  @keyframes rhc-merc-spec-drift {
    0%   { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }
    25%  { transform: translate(8px, -6px)  scale(1.2); opacity: 0.7; }
    50%  { transform: translate(7px, 7px)   scale(0.9); opacity: 0.95; }
    75%  { transform: translate(-8px, 6px)  scale(1.1); opacity: 0.7; }
    100% { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rhc-merc-halo,
    .rhc-merc-base,
    .rhc-merc-bulge,
    .rhc-merc-tint,
    .rhc-merc-spec { animation: none; }
  }
  .rhc-nav-c { display: flex; gap: 4px; }
  .rhc-nav-i {
    padding: 7px 12px;
    border-radius: 7px;
    font-size: 13.5px;
    color: var(--rhw-ink-soft);
    transition: background 0.15s, color 0.15s;
  }
  .rhc-nav-i:hover { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhc-nav-on { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhc-nav-r { display: flex; align-items: center; gap: 10px; justify-self: end; }
  .rhc-signin {
    padding: 7px 12px;
    font-size: 13.5px;
    color: var(--rhw-ink-soft);
    border-radius: 7px;
    transition: background 0.15s, color 0.15s;
  }
  .rhc-signin:hover { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhc-cta {
    padding: 8px 14px;
    background: var(--rhw-ink);
    color: #fff !important;
    border-radius: 8px;
    font-size: 13.5px; font-weight: 500;
    transition: background 0.15s;
  }
  .rhc-cta:hover { background: var(--rhw-accent); }

  @media (max-width: 720px) {
    .rhc-nav { grid-template-columns: auto 1fr auto; padding: 12px 18px; gap: 10px; }
    .rhc-nav-c { display: none; }
  }
`;

const FOOTER_STYLES = `
  .rhc-footer {
    padding: 56px 48px 32px;
    border-top: 1px solid var(--rhw-line);
    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
  }
  .rhc-footer *, .rhc-footer *::before, .rhc-footer *::after { box-sizing: border-box; }
  .rhc-footer a { color: var(--rhw-ink-soft); text-decoration: none; display: block; padding: 5px 0; font-size: 13.5px; }
  .rhc-footer a:hover { color: var(--rhw-accent); }
  .rhc-footer-grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 48px;
    padding-bottom: 36px;
    border-bottom: 1px solid var(--rhw-line);
    max-width: 1320px; margin: 0 auto;
  }
  .rhc-footer-brand {
    display: inline-flex; align-items: center; gap: 9px;
    font-size: 17px; font-weight: 600;
    margin-bottom: 14px;
    color: var(--rhw-ink);
  }
  .rhc-footer-blurb {
    font-size: 13.5px; line-height: 1.55;
    color: var(--rhw-ink-soft);
    max-width: 320px;
    margin: 0 0 14px;
  }
  .rhc-footer-h {
    font-size: 12px; letter-spacing: 0.04em;
    color: var(--rhw-ink-mute);
    margin-bottom: 14px;
    font-weight: 500;
  }
  .rhc-footer-base {
    display: flex; gap: 14px;
    padding-top: 22px;
    font-size: 12px;
    color: var(--rhw-ink-mute);
    align-items: center;
    max-width: 1320px; margin: 0 auto;
  }

  @media (max-width: 880px) {
    .rhc-footer-grid { grid-template-columns: 1fr 1fr; gap: 28px; }
    .rhc-footer-base { flex-wrap: wrap; }
  }
`;
