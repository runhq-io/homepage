import { useEffect, useRef, useState } from 'react';

const SIGNUP_URL = 'https://app.runhq.io/signup';
const LOGIN_URL = 'https://app.runhq.io';

const PRODUCTS: { label: string; href: string; desc: string }[] = [
  { label: 'Agent automation', href: '/agent-automation', desc: 'Describe a workflow. Agents build it.' },
  { label: 'Project management', href: '/projects', desc: 'Track every change, every signal.' },
  { label: 'Dev environment', href: '/runhq', desc: 'Agents code with full context.' },
  { label: 'Feedback widget', href: '/widget', desc: 'Capture user input from anywhere.' },
];

export default function HeroNavbar() {
  const [productsOpen, setProductsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProductsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="rh-nav">
      <style>{NAVBAR_STYLES}</style>

      <a className="rh-nav-brand" href="/">
        <div className="rh-nav-mark" />
        <span>RunHQ</span>
      </a>

      <nav className="rh-nav-links">
        <div ref={dropdownRef} className="rh-nav-products">
          <button
            type="button"
            className="rh-nav-link rh-nav-products-trigger"
            onClick={() => setProductsOpen((o) => !o)}
            aria-expanded={productsOpen}
          >
            Products
            <svg className={`rh-nav-chev ${productsOpen ? 'open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path d="M19 9l-7 7-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {productsOpen && (
            <div className="rh-nav-menu">
              {PRODUCTS.map((p) => (
                <a key={p.href} href={p.href} className="rh-nav-menu-item" onClick={() => setProductsOpen(false)}>
                  <div className="rh-nav-menu-label">{p.label}</div>
                  <div className="rh-nav-menu-desc">{p.desc}</div>
                </a>
              ))}
            </div>
          )}
        </div>
        <a className="rh-nav-link" href="/pricing">Pricing</a>
        <a className="rh-nav-link" href="/docs">Docs</a>
      </nav>

      <div className="rh-nav-cta">
        <a className="rh-nav-signin" href={LOGIN_URL}>Sign in</a>
        <a className="rh-nav-getstarted" href={SIGNUP_URL}>Get started</a>
      </div>
    </header>
  );
}

const NAVBAR_STYLES = `
  .rh-nav {
    position: absolute; top: 0; left: 0; right: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 18px 32px;
    font-family: 'Inter Tight', system-ui, sans-serif;
    font-size: 14px;
    color: oklch(0.97 0.005 240);
  }
  .rh-nav *, .rh-nav *::before, .rh-nav *::after { box-sizing: border-box; }

  .rh-nav-brand {
    display: inline-flex; align-items: center; gap: 10px;
    font-weight: 600; letter-spacing: -0.01em;
    color: inherit; text-decoration: none;
    font-size: 15px;
    margin-right: 18px;
  }
  .rh-nav-mark { width: 18px; height: 18px; position: relative; }
  .rh-nav-mark::before, .rh-nav-mark::after {
    content: ""; position: absolute; inset: 0;
    border: 1.5px solid oklch(0.86 0.19 180);
    border-radius: 50%;
  }
  .rh-nav-mark::after { animation: rh-nav-ring 2.2s ease-out infinite; }
  @keyframes rh-nav-ring {
    0%   { transform: scale(1);   opacity: 1; }
    100% { transform: scale(2.2); opacity: 0; }
  }

  .rh-nav-links {
    display: flex; align-items: center; gap: 2px;
  }
  .rh-nav-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px;
    border-radius: 8px;
    color: oklch(0.85 0.01 240);
    text-decoration: none;
    background: transparent;
    border: none;
    font: inherit;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .rh-nav-link:hover { color: oklch(0.98 0.005 240); background: rgba(255,255,255,0.05); }

  .rh-nav-products { position: relative; }
  .rh-nav-chev { transition: transform 0.18s; opacity: 0.65; }
  .rh-nav-chev.open { transform: rotate(180deg); }

  .rh-nav-menu {
    position: absolute; top: calc(100% + 8px); left: 0;
    width: 320px;
    padding: 8px;
    border-radius: 14px;
    background: rgba(14, 17, 22, 0.92);
    border: 1px solid rgba(255,255,255,0.10);
    backdrop-filter: blur(16px);
    box-shadow: 0 24px 60px -20px rgba(0,0,0,0.6);
    display: flex; flex-direction: column; gap: 2px;
  }
  .rh-nav-menu-item {
    display: block;
    padding: 10px 12px;
    border-radius: 10px;
    text-decoration: none;
    color: oklch(0.95 0.005 240);
    transition: background 0.15s;
  }
  .rh-nav-menu-item:hover { background: rgba(255,255,255,0.06); }
  .rh-nav-menu-label { font-size: 14px; font-weight: 500; }
  .rh-nav-menu-desc {
    font-size: 12px;
    color: oklch(0.7 0.01 240);
    margin-top: 2px;
  }

  .rh-nav-cta {
    display: inline-flex; align-items: center; gap: 8px;
    margin-left: auto;
  }
  .rh-nav-signin {
    color: oklch(0.85 0.01 240); text-decoration: none;
    padding: 8px 12px;
    border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }
  .rh-nav-signin:hover { color: oklch(0.98 0.005 240); background: rgba(255,255,255,0.05); }
  .rh-nav-getstarted {
    color: #061014;
    text-decoration: none;
    padding: 9px 16px;
    border-radius: 9px;
    font-weight: 500;
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    border: 1px solid oklch(0.86 0.18 180);
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.20),
      0 8px 24px -10px oklch(0.86 0.19 180 / 0.5),
      inset 0 1px 0 rgba(255,255,255,0.30);
    transition: transform 0.15s;
  }
  .rh-nav-getstarted:hover { transform: translateY(-1px); }

  @media (max-width: 820px) {
    .rh-nav { gap: 8px; padding: 14px 18px; }
    .rh-nav-links { display: none; }
  }
`;
