import { Navbar, Footer, SIGNUP_URL } from '../components/chrome';

const VALUES = [
  {
    h: 'Loops, not handoffs',
    p: 'Feedback, code, review, and ship live in one place. The faster a team closes the loop, the faster the product gets better.',
  },
  {
    h: 'Operate the agent',
    p: "Coding agents need a workplace, not a chatbox. We're building the operations layer where humans and agents do real work side by side.",
  },
  {
    h: 'Boring tooling, fast teams',
    p: 'Predictable pricing. Honest defaults. Tools that get out of the way so the team can run.',
  },
];

const FACTS = [
  { k: 'Founded', v: '2025' },
  { k: 'Headquartered', v: 'Vancouver, BC' },
  { k: 'Team', v: 'Small, distributed' },
  { k: 'Backers', v: 'Independent' },
];

export default function AboutPage() {
  return (
    <div className="rhp-root rha-root">
      <style>{ABOUT_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">About · RunHQ</div>
        <h1 className="rhp-hero-h1">A small team building the operations layer for AI coding agents.</h1>
        <p className="rhp-hero-lede">
          We started RunHQ because shipping software with agents felt nothing like the rest of our stack. Inboxes for feedback. Boards for tickets. Chat for review. We collapsed it into one loop.
        </p>
      </section>

      <section className="rha-facts">
        {FACTS.map((f) => (
          <div key={f.k} className="rha-fact">
            <div className="rha-fact-k">{f.k}</div>
            <div className="rha-fact-v">{f.v}</div>
          </div>
        ))}
      </section>

      <section className="rha-values">
        <h2 className="rha-h2">What we believe.</h2>
        <div className="rha-values-grid">
          {VALUES.map((v) => (
            <div key={v.h} className="rha-value">
              <div className="rha-value-h">{v.h}</div>
              <p className="rha-value-p">{v.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rha-contact">
        <h2 className="rha-h2">Get in touch.</h2>
        <p className="rha-contact-p">
          Press, partnerships, or anything else — <a className="rha-link" href="mailto:admin@runhq.io">admin@runhq.io</a>.
        </p>
        <div className="rha-cta-row">
          <a className="rhp-btn-primary" href={SIGNUP_URL}>Start free →</a>
        </div>
      </section>

      <Footer />
    </div>
  );
}

const ABOUT_STYLES = `
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
    display: inline-block; padding: 4px 11px;
    background: var(--rhw-bg-2); border: 1px solid var(--rhw-line);
    border-radius: 999px; font-size: 11.5px; color: var(--rhw-ink-soft);
    letter-spacing: 0.04em; margin-bottom: 22px;
  }
  .rhp-hero-h1 {
    font-size: 56px; line-height: 1.05; letter-spacing: -0.034em;
    font-weight: 600; margin: 0 0 18px; text-wrap: balance;
  }
  .rhp-hero-lede {
    font-size: 19px; line-height: 1.55; color: var(--rhw-ink-soft);
    max-width: 680px; margin: 0 auto; text-wrap: pretty;
  }
  .rhp-btn-primary {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 20px;
    background: var(--rhw-ink); color: #fff !important;
    border-radius: 9px; font-size: 14px; font-weight: 500;
    border: none; cursor: pointer; transition: background 0.15s;
  }
  .rhp-btn-primary:hover { background: var(--rhw-accent); }

  .rha-facts {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 0;
    max-width: 1100px; margin: 28px auto 0;
    padding: 24px 48px;
    border-top: 1px solid var(--rhw-line);
    border-bottom: 1px solid var(--rhw-line);
  }
  .rha-fact { padding: 6px 18px; border-left: 1px solid var(--rhw-line-soft); }
  .rha-fact:first-child { border-left: none; padding-left: 0; }
  .rha-fact-k {
    font-size: 11.5px; letter-spacing: 0.04em;
    color: var(--rhw-ink-mute); margin-bottom: 4px;
  }
  .rha-fact-v {
    font-size: 16px; font-weight: 500; color: var(--rhw-ink);
    letter-spacing: -0.005em;
  }

  .rha-values { padding: 80px 48px 60px; max-width: 1100px; margin: 0 auto; }
  .rha-h2 {
    font-size: 32px; font-weight: 600; letter-spacing: -0.022em;
    margin: 0 0 28px;
  }
  .rha-values-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;
  }
  .rha-value {
    padding: 24px; border: 1px solid var(--rhw-line);
    border-radius: 12px; background: var(--rhw-surface);
  }
  .rha-value-h {
    font-size: 16px; font-weight: 600; margin-bottom: 8px;
    letter-spacing: -0.01em;
  }
  .rha-value-p {
    font-size: 14px; line-height: 1.6;
    color: var(--rhw-ink-soft); margin: 0;
  }

  .rha-contact { padding: 60px 48px 96px; max-width: 1100px; margin: 0 auto; }
  .rha-contact-p {
    font-size: 16px; color: var(--rhw-ink-soft);
    max-width: 560px; margin: 0 0 22px;
  }
  .rha-link { color: var(--rhw-accent) !important; }
  .rha-link:hover { text-decoration: underline; }
  .rha-cta-row { display: flex; gap: 10px; }

  @media (max-width: 880px) {
    .rhp-hero { padding: 56px 24px 24px; }
    .rhp-hero-h1 { font-size: 38px; }
    .rha-facts {
      grid-template-columns: 1fr 1fr; gap: 18px 0;
      padding: 22px 24px;
    }
    .rha-fact { border-left: none; padding-left: 0; }
    .rha-values { padding: 48px 24px; }
    .rha-values-grid { grid-template-columns: 1fr; }
    .rha-contact { padding: 36px 24px 64px; }
    .rha-h2 { font-size: 26px; }
  }
`;
