const SIGNUP_URL = 'https://app.runhq.io/signup';

const FEATURES = [
  {
    title: 'Coding agents',
    desc: 'Claude Code, Cursor, Codex, Devin — bring your own or use ours.',
  },
  {
    title: 'Feedback widget',
    desc: 'Drop-in script that captures context on every submit.',
  },
  {
    title: 'Project boards',
    desc: 'Public or private. Vote, triage, watch agents work in the open.',
  },
  {
    title: 'Slack + Linear + GitHub + Intercom',
    desc: 'Two-way sync. Signals in. PRs out. No copy-paste.',
  },
  {
    title: 'Unlimited team members',
    desc: 'No seat tax. Everyone reviews. Everyone ships.',
  },
  {
    title: 'Audit log',
    desc: 'Every signal, every prompt, every diff — recorded with full provenance.',
  },
];

const FAQS = [
  {
    q: "Why custom pricing?",
    a: "Volume swings 5-10× across teams. Per-seat pricing punishes you for inviting reviewers — exactly what we don’t want. We talk, we land on a number, you don’t get gouged.",
  },
  {
    q: "What’s included in the starting tier?",
    a: "All agents, all integrations, the widget, audit log, and unlimited seats. The number scales with feedback volume — not headcount.",
  },
  {
    q: "Can we self-host?",
    a: "Not yet. Enterprise self-hosting is on the roadmap — get in touch if it’s a hard requirement.",
  },
  {
    q: "Free trial?",
    a: "We do a 14-day pilot on a single project. Sign up and we’ll set it up.",
  },
];

function CheckIcon() {
  return (
    <svg
      className="rh-pricing-check"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 10.5l4.5 4.5 7.5-9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function PricingPage() {
  return (
    <div className="rh-pricing">
      <style>{PRICING_STYLES}</style>

      {/* HERO */}
      <section className="rh-pricing-hero">
        <div className="rh-pricing-eyebrow mono">PRICING</div>
        <h1 className="rh-pricing-headline">
          Per-team pricing. <em>No per-seat tax.</em>
        </h1>
        <p className="rh-pricing-sub">
          Custom packages priced around your volume and integrations. Everyone
          on your team gets in — designers, PMs, founders, support, the whole
          crew.
        </p>
      </section>

      {/* PRICE CARD */}
      <section className="rh-pricing-card-section">
        <div className="rh-pricing-card">
          <div className="rh-pricing-card-bar" />
          <div className="rh-pricing-card-eyebrow mono">ALL-INCLUSIVE</div>
          <div className="rh-pricing-starting">Starting at</div>
          <div className="rh-pricing-price">
            $12,000<span className="rh-pricing-per">/year</span>
          </div>
          <p className="rh-pricing-card-desc">
            Everyone on your team. Every integration. Every agent. One bill.
          </p>
          <a className="rh-cta-primary" href={SIGNUP_URL}>
            Talk to us
          </a>
        </div>
      </section>

      {/* FEATURES */}
      <section className="rh-pricing-features">
        <div className="rh-pricing-section-inner">
          <h2 className="rh-pricing-section-title">Everything in the box.</h2>
          <div className="rh-pricing-feature-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="rh-pricing-feature-item">
                <CheckIcon />
                <div>
                  <h3 className="rh-pricing-feature-title">{f.title}</h3>
                  <p className="rh-pricing-feature-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="rh-pricing-faq">
        <div className="rh-pricing-section-inner">
          <h2 className="rh-pricing-section-title">Common questions.</h2>
          <div className="rh-pricing-faq-list">
            {FAQS.map((item) => (
              <div key={item.q} className="rh-pricing-faq-item">
                <div className="rh-pricing-faq-q mono">{item.q}</div>
                <p className="rh-pricing-faq-a">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA BAND */}
      <section className="rh-pricing-cta-band">
        <h2 className="rh-pricing-cta-title">
          Ready to close the loop?
        </h2>
        <div className="rh-pricing-cta-actions">
          <a className="rh-cta-primary" href={SIGNUP_URL}>Talk to us</a>
          <a className="rh-cta-ghost" href="/agent-automation">Try the demo</a>
        </div>
      </section>
    </div>
  );
}

const PRICING_STYLES = `
  .rh-pricing {
    background: var(--bg-deep);
    color: var(--ink);
    font-family: 'Inter Tight', system-ui, sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
  }
  .rh-pricing *, .rh-pricing *::before, .rh-pricing *::after { box-sizing: border-box; }

  /* ── HERO ──────────────────────────────────────────────────────────── */
  .rh-pricing-hero {
    padding: 120px 32px 80px;
    max-width: 860px;
    margin: 0 auto;
    text-align: center;
  }
  .rh-pricing-eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    margin-bottom: 20px;
  }
  .rh-pricing-headline {
    font-size: clamp(38px, 5.2vw, 68px);
    line-height: 1.04;
    letter-spacing: -0.025em;
    font-weight: 500;
    margin: 0 0 28px;
    text-wrap: balance;
    color: var(--ink);
  }
  .rh-pricing-headline em {
    font-style: normal;
    background: linear-gradient(100deg,
      oklch(0.96 0.14 180) 0%,
      oklch(0.88 0.22 160) 60%,
      oklch(0.85 0.22 130) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .rh-pricing-sub {
    font-size: 18px;
    line-height: 1.55;
    color: var(--ink-dim);
    max-width: 600px;
    margin: 0 auto;
  }

  /* ── PRICE CARD ────────────────────────────────────────────────────── */
  .rh-pricing-card-section {
    padding: 0 32px 96px;
    display: flex;
    justify-content: center;
  }
  .rh-pricing-card {
    position: relative;
    background: rgba(14, 17, 22, 0.7);
    border: 1px solid var(--line-bold);
    border-radius: 20px;
    padding: 48px 36px;
    max-width: 460px;
    width: 100%;
    text-align: center;
    overflow: hidden;
  }
  .rh-pricing-card-bar {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(100deg,
      oklch(0.96 0.14 180) 0%,
      oklch(0.88 0.22 160) 60%,
      oklch(0.85 0.22 130) 100%);
  }
  .rh-pricing-card-eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    margin-bottom: 28px;
  }
  .rh-pricing-starting {
    font-size: 15px;
    color: var(--ink-mute);
    margin-bottom: 6px;
  }
  .rh-pricing-price {
    font-size: clamp(54px, 6vw, 88px);
    line-height: 1;
    letter-spacing: -0.025em;
    font-weight: 500;
    color: var(--ink);
    margin-bottom: 20px;
  }
  .rh-pricing-per {
    font-size: 22px;
    font-weight: 400;
    color: var(--ink-mute);
    margin-left: 4px;
  }
  .rh-pricing-card-desc {
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink-dim);
    margin: 0 0 32px;
  }

  /* ── SHARED SECTION INNER ──────────────────────────────────────────── */
  .rh-pricing-section-inner {
    max-width: 860px;
    margin: 0 auto;
  }
  .rh-pricing-section-title {
    font-size: clamp(28px, 3.8vw, 44px);
    line-height: 1.08;
    letter-spacing: -0.02em;
    font-weight: 500;
    margin: 0 0 48px;
    color: var(--ink);
  }

  /* ── FEATURES ──────────────────────────────────────────────────────── */
  .rh-pricing-features {
    border-top: 1px solid var(--line);
    padding: 80px 32px;
  }
  .rh-pricing-feature-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
  }
  .rh-pricing-feature-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 24px 20px 24px 0;
    border-bottom: 1px solid var(--line);
  }
  .rh-pricing-feature-item:nth-child(4),
  .rh-pricing-feature-item:nth-child(5),
  .rh-pricing-feature-item:nth-child(6) {
    border-bottom: none;
  }
  .rh-pricing-check {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--accent);
  }
  .rh-pricing-feature-title {
    font-size: 15px;
    font-weight: 500;
    color: var(--ink);
    margin: 0 0 5px;
    line-height: 1.3;
  }
  .rh-pricing-feature-desc {
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink-dim);
    margin: 0;
  }

  /* ── FAQ ───────────────────────────────────────────────────────────── */
  .rh-pricing-faq {
    border-top: 1px solid var(--line);
    padding: 80px 32px;
  }
  .rh-pricing-faq-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .rh-pricing-faq-item {
    border-top: 1px solid var(--line);
    padding: 28px 0;
    display: grid;
    grid-template-columns: 1fr 1.6fr;
    gap: 40px;
    align-items: start;
  }
  .rh-pricing-faq-item:last-child {
    border-bottom: 1px solid var(--line);
  }
  .rh-pricing-faq-q {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink-mute);
    padding-top: 2px;
  }
  .rh-pricing-faq-a {
    font-size: 15px;
    line-height: 1.6;
    color: var(--ink-dim);
    margin: 0;
  }

  /* ── CTA BAND ──────────────────────────────────────────────────────── */
  .rh-pricing-cta-band {
    border-top: 1px solid var(--line);
    padding: 100px 32px;
    text-align: center;
  }
  .rh-pricing-cta-title {
    font-size: clamp(28px, 3.4vw, 44px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-weight: 500;
    margin: 0 0 32px;
    color: var(--ink);
    text-wrap: balance;
  }
  .rh-pricing-cta-actions {
    display: inline-flex;
    gap: 12px;
  }

  /* ── SHARED BUTTONS ────────────────────────────────────────────────── */
  .rh-cta-primary {
    display: inline-block;
    padding: 14px 24px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    color: #061014;
    text-decoration: none;
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    border: 1px solid oklch(0.86 0.18 180);
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.25),
      0 12px 44px -10px oklch(0.86 0.19 180 / 0.5),
      inset 0 1px 0 rgba(255,255,255,0.30);
    transition: transform 0.18s;
    cursor: pointer;
  }
  .rh-cta-primary:hover { transform: translateY(-1px); }
  .rh-cta-ghost {
    display: inline-block;
    padding: 14px 22px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    color: var(--ink);
    text-decoration: none;
    background: rgba(14, 17, 22, 0.55);
    border: 1px solid var(--line-bold);
    transition: border-color 0.18s, color 0.18s;
  }
  .rh-cta-ghost:hover { border-color: var(--accent); color: var(--accent); }

  /* ── RESPONSIVE ────────────────────────────────────────────────────── */
  @media (max-width: 880px) {
    .rh-pricing-hero { padding: 80px 22px 60px; }
    .rh-pricing-card-section { padding: 0 22px 72px; }
    .rh-pricing-features,
    .rh-pricing-faq,
    .rh-pricing-cta-band { padding: 60px 22px; }
    .rh-pricing-feature-grid { grid-template-columns: 1fr; }
    .rh-pricing-feature-item { border-bottom: 1px solid var(--line); }
    .rh-pricing-feature-item:last-child { border-bottom: none; }
    .rh-pricing-feature-item:nth-child(4),
    .rh-pricing-feature-item:nth-child(5) { border-bottom: 1px solid var(--line); }
    .rh-pricing-faq-item { grid-template-columns: 1fr; gap: 10px; }
    .rh-pricing-cta-actions { flex-direction: column; align-items: center; }
    .rh-pricing-section-title { margin-bottom: 32px; }
  }
`;
