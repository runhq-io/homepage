import { Fragment, useState } from 'react';
import { Navbar, Footer, Wordmark, LOGOS, SIGNUP_URL } from '../components/chrome';

type Plan = {
  key: string;
  name: string;
  tag: string;
  monthly: number | null;
  annual: number | null;
  unit: string;
  seat: number | null;
  pitch: string;
  cta: string;
  ghost: boolean;
  popular?: boolean;
  highlights: string[];
};

const PLANS: Plan[] = [
  {
    key: 'starter', name: 'Starter', tag: 'Best for new teams',
    monthly: 20, annual: 15, unit: '/mo', seat: 10,
    pitch: 'Route feedback to any coding agent. Solo dev or a new team.',
    cta: 'Get started', ghost: false,
    highlights: [
      '$15 in agent credit / mo',
      'All supported coding agents',
    ],
  },
  {
    key: 'pro', name: 'Pro', tag: 'Best for shipping teams',
    monthly: 100, annual: 75, unit: '/mo', seat: 15,
    pitch: 'Internal feedback widget for your team and 5× the agent credit.',
    cta: 'Get started', ghost: false,
    highlights: [
      'Everything in Starter, plus:',
      '$75 in agent credit / mo',
      'Internal feedback widget (team members only)',
    ],
  },
  {
    key: 'scale', name: 'Scale', tag: 'Best for scale-ups',
    monthly: 250, annual: 200, unit: '/mo', seat: 25,
    pitch: 'Public user-facing widget, graph-based agent flow, higher credit.',
    cta: 'Get started', ghost: false, popular: true,
    highlights: [
      'Everything in Pro, plus:',
      '$200 in agent credit / mo',
      'Public user-facing widget',
      'Graph-based agent flow',
      'Higher concurrency limits',
    ],
  },
  {
    key: 'enterprise', name: 'Enterprise', tag: 'Best for regulated org charts',
    monthly: null, annual: null, unit: '', seat: null,
    pitch: 'Single-tenant deployment, custom DPA, dedicated POC.',
    cta: 'Contact us', ghost: true,
    highlights: [
      'Everything in Scale, plus:',
      'Single-tenant deployment',
      'Custom DPA + MSA',
      'Dedicated POC',
    ],
  },
];

type Cell = string | boolean;
const COMPARE: { sec: string; rows: [string, Cell, Cell, Cell, Cell][] }[] = [
  { sec: 'Workspace', rows: [
    ['Projects',                  '3',          'Unlimited',         'Unlimited',         'Unlimited'],
    ['Reviewers (read-only)',     'Unlimited',  'Unlimited',         'Unlimited',         'Unlimited'],
    ['Internal widget (team members)', false,    true,                true,                true],
    ['Public user-facing widget', false,         false,               true,                true],
  ]},
  { sec: 'Agents & credit', rows: [
    ['Monthly agent credit',      '$15',        '$75',               '$200',              'Custom'],
    ['Claude Code',               true,         true,                true,                true],
    ['Codex',                     true,         true,                true,                true],
    ['Browser + terminal execution', true,      true,                true,                true],
    ['Graph-based agent flow',    false,        false,               true,                true],
    ['Concurrent runs',           '2',          '5',                 '25',                'Custom'],
  ]},
  { sec: 'Governance', rows: [
    ['Prompt + diff provenance',  true,         true,                true,                true],
    ['Custom DPA',                false,        false,               false,               true],
    ['Single-tenant deployment',  false,        false,               false,               true],
  ]},
];

const FAQ = [
  { q: 'How does seat pricing work?',
    a: 'You pay a flat platform fee per month plus a per-seat charge for every team member with edit access. Read-only reviewers — designers, support, your CEO — are always free, on every plan.' },
  { q: "What's the difference between a seat and a reviewer?",
    a: 'Seats dispatch agents and ship work. Reviewers comment, vote, and watch — read-only, unlimited, free on every plan. Most teams have 3-4× more reviewers than seats.' },
  { q: 'How does the monthly agent credit work?',
    a: 'Every plan includes a pool of agent credit that resets at the start of each billing cycle — $15 on Starter, $75 on Pro, $200 on Scale. Credit pays for token spend across all supported coding agents. Unused credit does not roll over.' },
  { q: 'What happens if I run out of credit?',
    a: "Agent runs pause until the next cycle or until you top up. We never auto-charge overages — you'll see usage in-app long before you hit zero, and you can upgrade or add credit with one click." },
  { q: 'Which coding agents do you support?',
    a: 'All of them. Each RunHQ workspace runs on its own VPS, so anything that works on Linux — Claude Code, Codex, Cursor CLI, Aider, custom scripts — runs out of the box. You bring your own Claude or Codex subscription; RunHQ never sits between you and the model provider.' },
];

const CompareCell = ({ v }: { v: Cell }) => {
  if (v === true) return <span className="rhpx-yes">✓</span>;
  if (v === false) return <span className="rhpx-no">—</span>;
  return <span className="rhpx-text">{v}</span>;
};

export default function PricingPage() {
  const [billing, setBilling] = useState<'monthly' | 'annual'>('annual');

  return (
    <div className="rhp-root rhpx-root">
      <style>{PRICING_STYLES}</style>
      <Navbar active="pricing" />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">Pricing · Predictable platform + seats</div>
        <h1 className="rhp-hero-h1">Predictable pricing that scales with your team.</h1>
        <p className="rhp-hero-lede">
          A flat platform fee plus a per-seat charge — no surprises, no usage cliffs. Read-only reviewers are always free.
        </p>

        <div className="rhpx-toggle">
          <button
            type="button"
            className={`rhpx-toggle-btn ${billing === 'monthly' ? 'rhpx-toggle-on' : ''}`}
            onClick={() => setBilling('monthly')}
          >Monthly</button>
          <button
            type="button"
            className={`rhpx-toggle-btn ${billing === 'annual' ? 'rhpx-toggle-on' : ''}`}
            onClick={() => setBilling('annual')}
          >Annual <span className="rhpx-toggle-pill">Save 25%</span></button>
        </div>
      </section>

      {/* PLAN CARDS */}
      <section className="rhpx-plans">
        {PLANS.map((p) => {
          const price = billing === 'monthly' ? p.monthly : p.annual;
          const showPrice = price !== null;
          return (
            <div key={p.key} className={`rhpx-plan ${p.popular ? 'rhpx-plan-pop' : ''}`}>
              {p.popular && <div className="rhpx-plan-flag">Most popular</div>}
              <div className="rhpx-plan-name">{p.name}</div>
              <div className="rhpx-plan-tag">{p.tag}</div>

              <div className="rhpx-plan-price">
                {showPrice ? (
                  <>
                    <span className="rhpx-plan-cur">$</span>
                    <span className="rhpx-plan-num">{price}</span>
                    <span className="rhpx-plan-unit">{p.unit}</span>
                  </>
                ) : (
                  <span className="rhpx-plan-custom">Custom</span>
                )}
              </div>
              <div className="rhpx-plan-seat">
                {showPrice && p.seat !== null ? `+ $${p.seat}/seat` : ' '}
              </div>
              {showPrice && billing === 'annual' && (
                <div className="rhpx-plan-billed">billed annually</div>
              )}
              {showPrice && billing === 'monthly' && (
                <div className="rhpx-plan-billed">billed monthly</div>
              )}
              {!showPrice && <div className="rhpx-plan-billed">priced to your volume</div>}

              <a
                className={p.ghost ? 'rhpx-plan-cta rhpx-plan-cta-ghost' : 'rhpx-plan-cta rhpx-plan-cta-fill'}
                href={SIGNUP_URL}
              >{p.cta} →</a>

              <p className="rhpx-plan-pitch">{p.pitch}</p>

              <ul className="rhpx-plan-feats">
                {p.highlights.map((h, i) => (
                  <li key={i}>
                    <span className="rhpx-plan-check">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* TRUSTED BY */}
      <section className="rhpx-trust">
        <div className="rhpx-trust-h">Trusted by 1,400+ teams shipping with agents</div>
        <div className="rhpx-trust-row">
          {LOGOS.map((name) => <Wordmark key={name} name={name} size={18} color="var(--rhw-ink-mute)" />)}
        </div>
      </section>

      {/* COMPARE */}
      <section className="rhpx-compare">
        <h2 className="rhpx-compare-h">Compare every feature.</h2>
        <p className="rhpx-compare-sub">Side-by-side, all four plans, every line item.</p>

        <div className="rhpx-compare-wrap">
          <table className="rhpx-table">
            <thead>
              <tr>
                <th></th>
                {PLANS.map((p) => (
                  <th key={p.key} className={p.popular ? 'rhpx-th-pop' : ''}>
                    <div className="rhpx-th-name">{p.name}</div>
                    <div className="rhpx-th-price">
                      {p.monthly === null
                        ? 'Custom'
                        : `$${billing === 'annual' ? p.annual : p.monthly}${p.unit} + $${p.seat}/seat`}
                    </div>
                    <a
                      className={p.ghost ? 'rhpx-th-cta rhpx-plan-cta-ghost' : 'rhpx-th-cta rhpx-plan-cta-fill'}
                      href={SIGNUP_URL}
                    >{p.cta}</a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((s) => (
                <Fragment key={s.sec}>
                  <tr className="rhpx-sec-row"><td colSpan={5}>{s.sec}</td></tr>
                  {s.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="rhpx-row-h">{r[0]}</td>
                      <td><CompareCell v={r[1]} /></td>
                      <td className="rhpx-td-pop"><CompareCell v={r[2]} /></td>
                      <td><CompareCell v={r[3]} /></td>
                      <td><CompareCell v={r[4]} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* SAVE CALLOUT */}
      <section className="rhpx-save">
        <div className="rhpx-save-card">
          <div className="rhpx-save-l">
            <div className="rhpx-save-pill">Why teams switch</div>
            <h3 className="rhpx-save-h">Replace 3 tools with 1 — save ~$17,000/yr</h3>
            <p className="rhpx-save-p">
              The average RunHQ Pro customer drops their feedback widget, agent ops dashboard, and ticket triage tool. Same loop, one bill.
            </p>
          </div>
          <div className="rhpx-save-r">
            {[
              { t: 'Feedback widget',   v: '$8,400 / yr' },
              { t: 'Agent dashboard',   v: '$7,800 / yr' },
              { t: 'Ticket triage tool', v: '$3,000 / yr' },
            ].map((r) => (
              <div key={r.t} className="rhpx-save-row">
                <span className="rhpx-save-strike">{r.t}</span>
                <span className="rhpx-save-val">{r.v}</span>
              </div>
            ))}
            <div className="rhpx-save-total">
              <span>RunHQ Pro, annual (8 seats)</span>
              <span className="rhpx-save-total-v">$2,340 / yr</span>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="rhpx-faq">
        <h2 className="rhpx-compare-h">Frequently asked.</h2>
        <div className="rhpx-faq-list">
          {FAQ.map((f, i) => (
            <details key={i} className="rhpx-faq-item">
              <summary className="rhpx-faq-q">
                <span>{f.q}</span>
                <span className="rhpx-faq-chev">+</span>
              </summary>
              <p className="rhpx-faq-a">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="rhpx-cta">
        <h2 className="rhpx-cta-h">Pick a plan. Get the loop running today.</h2>
        <div className="rhpx-cta-row">
          <a className="rhp-btn-primary" href={SIGNUP_URL}>Get started →</a>
          <a className="rhp-btn-ghost" href={SIGNUP_URL}>Talk to sales</a>
        </div>
        <div className="rhpx-cta-meta">Switch plans anytime · Cancel from Settings</div>
      </section>

      <Footer />
    </div>
  );
}

const PRICING_STYLES = `
  .rhp-root {
    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .rhp-root *, .rhp-root *::before, .rhp-root *::after { box-sizing: border-box; }
  .rhp-root a { color: inherit; text-decoration: none; }

  .rhp-hero { padding: 80px 48px 36px; text-align: center; max-width: 1100px; margin: 0 auto; }
  .rhp-hero-eyebrow {
    display: inline-block;
    padding: 4px 11px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--rhw-ink-soft);
    letter-spacing: 0.04em;
    margin-bottom: 22px;
  }
  .rhp-hero-h1 {
    font-size: 56px;
    line-height: 1.05;
    letter-spacing: -0.034em;
    font-weight: 600;
    margin: 0 0 18px;
    text-wrap: balance;
  }
  .rhp-hero-lede {
    font-size: 19px;
    line-height: 1.55;
    color: var(--rhw-ink-soft);
    max-width: 680px;
    margin: 0 auto;
    text-wrap: pretty;
  }
  .rhp-btn-primary {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px;
    background: var(--rhw-ink); color: #fff !important;
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    border: none; cursor: pointer;
    transition: background 0.15s;
  }
  .rhp-btn-primary:hover { background: var(--rhw-accent); }
  .rhp-btn-ghost {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 18px;
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .rhp-btn-ghost:hover { border-color: var(--rhw-ink); }

  .rhpx-toggle {
    display: inline-flex; gap: 4px;
    padding: 4px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    border-radius: 11px;
    margin-top: 28px;
  }
  .rhpx-toggle-btn {
    padding: 8px 16px;
    border: 0; background: transparent;
    border-radius: 8px;
    font: inherit; font-size: 13.5px; font-weight: 500;
    color: var(--rhw-ink-soft);
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .rhpx-toggle-on { background: var(--rhw-ink); color: #fff; }
  .rhpx-toggle-pill {
    font-size: 10.5px; padding: 2px 7px;
    background: oklch(0.75 0.18 145);
    color: #07271a;
    border-radius: 999px;
    font-weight: 600;
  }

  .rhpx-plans {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    padding: 32px 48px 64px;
    max-width: 1320px; margin: 0 auto;
  }
  .rhpx-plan {
    position: relative;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 16px;
    padding: 28px 24px;
    display: flex; flex-direction: column;
  }
  .rhpx-plan-pop {
    border: 2px solid var(--rhw-ink);
    box-shadow: 0 30px 60px -30px rgba(20, 19, 15, 0.18);
  }
  .rhpx-plan-flag {
    position: absolute; top: -12px; left: 24px;
    padding: 4px 10px;
    background: var(--rhw-ink);
    color: #fff;
    border-radius: 999px;
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.04em;
  }
  .rhpx-plan-name { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .rhpx-plan-tag { font-size: 12.5px; color: var(--rhw-ink-mute); margin: 4px 0 22px; }
  .rhpx-plan-price { display: flex; align-items: baseline; gap: 4px; }
  .rhpx-plan-cur { font-size: 22px; color: var(--rhw-ink-soft); }
  .rhpx-plan-num { font-size: 48px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
  .rhpx-plan-unit { font-size: 13px; color: var(--rhw-ink-mute); margin-left: 4px; }
  .rhpx-plan-custom { font-size: 36px; font-weight: 600; letter-spacing: -0.03em; }
  .rhpx-plan-seat { font-size: 13.5px; color: var(--rhw-ink-soft); margin-top: 8px; font-weight: 500; min-height: 18px; }
  .rhpx-plan-billed { font-size: 11.5px; color: var(--rhw-ink-mute); margin-top: 4px; min-height: 16px; }
  .rhpx-plan-cta {
    margin: 18px 0 16px;
    padding: 11px 16px;
    border-radius: 9px;
    font-size: 13.5px; font-weight: 500;
    text-align: center;
    cursor: pointer;
    display: block;
  }
  .rhpx-plan-cta-fill {
    background: var(--rhw-ink);
    color: #fff !important;
    border: 1px solid var(--rhw-ink);
  }
  .rhpx-plan-cta-fill:hover { background: var(--rhw-accent); border-color: var(--rhw-accent); }
  .rhpx-plan-cta-ghost {
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
  }
  .rhpx-plan-cta-ghost:hover { border-color: var(--rhw-ink); }
  .rhpx-plan-pitch { font-size: 13px; line-height: 1.5; color: var(--rhw-ink-soft); margin: 0 0 18px; min-height: 56px; }
  .rhpx-plan-feats {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 10px;
    padding-top: 18px;
    border-top: 1px solid var(--rhw-line-soft);
  }
  .rhpx-plan-feats li {
    display: flex; gap: 9px;
    font-size: 13.5px; line-height: 1.45;
    color: var(--rhw-ink);
  }
  .rhpx-plan-check { color: var(--rhw-good); font-weight: 700; flex-shrink: 0; }

  .rhpx-trust {
    padding: 24px 48px 56px;
    max-width: 1300px; margin: 0 auto;
    text-align: center;
    border-top: 1px solid var(--rhw-line-soft);
  }
  .rhpx-trust-h {
    font-size: 12px; letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 22px;
  }
  .rhpx-trust-row {
    display: flex; flex-wrap: wrap;
    justify-content: center;
    gap: 32px 40px;
    opacity: 0.85;
  }

  .rhpx-compare { padding: 64px 48px; max-width: 1300px; margin: 0 auto; }
  .rhpx-compare-h { font-size: 36px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 8px; text-align: center; }
  .rhpx-compare-sub { color: var(--rhw-ink-mute); text-align: center; margin: 0 0 32px; }
  .rhpx-compare-wrap {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    overflow: hidden;
    overflow-x: auto;
  }
  .rhpx-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .rhpx-table th, .rhpx-table td {
    padding: 14px 16px;
    text-align: center;
    border-bottom: 1px solid var(--rhw-line-soft);
    vertical-align: middle;
  }
  .rhpx-table thead th {
    background: var(--rhw-bg-2);
    padding: 22px 16px;
    border-bottom: 1px solid var(--rhw-line);
  }
  .rhpx-th-pop { background: var(--rhw-ink) !important; color: #fff; }
  .rhpx-th-pop .rhpx-th-cta.rhpx-plan-cta-fill { background: #fff; color: var(--rhw-ink) !important; border-color: #fff; }
  .rhpx-th-name { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .rhpx-th-price { font-size: 12px; color: var(--rhw-ink-mute); margin-bottom: 12px; }
  .rhpx-th-pop .rhpx-th-price { color: rgba(255,255,255,0.65); }
  .rhpx-th-cta {
    padding: 7px 12px;
    border-radius: 7px;
    font-size: 12px; font-weight: 500;
    cursor: pointer;
    display: inline-block;
  }
  .rhpx-row-h { text-align: left !important; font-weight: 500; color: var(--rhw-ink); }
  .rhpx-sec-row td {
    background: var(--rhw-bg) !important;
    padding: 16px 16px 8px !important;
    text-align: left !important;
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    border-bottom: 1px solid var(--rhw-line);
  }
  .rhpx-yes { color: var(--rhw-good); font-weight: 700; }
  .rhpx-no { color: var(--rhw-ink-faint); }
  .rhpx-text { font-size: 13px; color: var(--rhw-ink-soft); }
  .rhpx-td-pop { background: rgba(20,19,15,0.025); }

  .rhpx-save { padding: 32px 48px 64px; max-width: 1300px; margin: 0 auto; }
  .rhpx-save-card {
    background: var(--rhw-ink); color: #fff;
    border-radius: 18px;
    padding: 48px;
    display: grid; grid-template-columns: 1.2fr 1fr;
    gap: 56px; align-items: center;
  }
  .rhpx-save-pill {
    display: inline-block;
    padding: 4px 11px;
    background: rgba(255,255,255,0.12);
    border-radius: 999px;
    font-size: 11px; letter-spacing: 0.06em;
    margin-bottom: 16px;
  }
  .rhpx-save-h { font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; margin: 0 0 14px; }
  .rhpx-save-p { color: rgba(255,255,255,0.7); margin: 0; line-height: 1.55; }
  .rhpx-save-r { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 18px 20px; }
  .rhpx-save-row {
    display: flex; justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    font-size: 13.5px;
  }
  .rhpx-save-strike { text-decoration: line-through; color: rgba(255,255,255,0.5); }
  .rhpx-save-val { color: rgba(255,255,255,0.5); }
  .rhpx-save-total {
    display: flex; justify-content: space-between;
    padding: 14px 0 4px;
    font-size: 14.5px; font-weight: 500;
  }
  .rhpx-save-total-v { color: oklch(0.85 0.18 145); font-weight: 600; }

  .rhpx-faq { padding: 64px 48px; max-width: 920px; margin: 0 auto; }
  .rhpx-faq-list { display: flex; flex-direction: column; gap: 4px; margin-top: 28px; }
  .rhpx-faq-item {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
  }
  .rhpx-faq-item[open] { border-color: var(--rhw-ink); }
  .rhpx-faq-q {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 22px;
    cursor: pointer;
    font-size: 15px; font-weight: 500;
    list-style: none;
  }
  .rhpx-faq-q::-webkit-details-marker { display: none; }
  .rhpx-faq-chev { font-size: 20px; color: var(--rhw-ink-mute); font-weight: 300; transition: transform 0.2s; }
  .rhpx-faq-item[open] .rhpx-faq-chev { transform: rotate(45deg); }
  .rhpx-faq-a { padding: 0 22px 20px; margin: 0; color: var(--rhw-ink-soft); line-height: 1.6; font-size: 14px; }

  .rhpx-cta { padding: 56px 48px 80px; text-align: center; max-width: 800px; margin: 0 auto; }
  .rhpx-cta-h { font-size: 38px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 24px; text-wrap: balance; }
  .rhpx-cta-row { display: inline-flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  .rhpx-cta-meta { font-size: 12.5px; color: var(--rhw-ink-mute); margin-top: 16px; }

  @media (max-width: 1100px) {
    .rhpx-plans { grid-template-columns: repeat(2, 1fr); }
    .rhpx-save-card { grid-template-columns: 1fr; gap: 32px; padding: 32px; }
  }
  @media (max-width: 720px) {
    .rhpx-plans { grid-template-columns: 1fr; padding: 20px 24px 48px; }
    .rhp-hero { padding: 56px 24px 24px; }
    .rhp-hero-h1 { font-size: 38px; }
    .rhpx-compare { padding: 48px 16px; }
    .rhpx-faq, .rhpx-cta { padding-left: 24px; padding-right: 24px; }
    .rhpx-save { padding: 24px 24px 48px; }
  }
`;
