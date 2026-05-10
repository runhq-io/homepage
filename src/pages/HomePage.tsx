import { useEffect, useRef, useState } from 'react';
import { Navbar, Footer, Avatar, AgentIcon, SourceIcon, Wordmark, LOGOS, SIGNUP_URL, LOGIN_URL } from '../components/chrome';
import { PipelineCanvas, BEFORE_STATIONS, AFTER_STATIONS, VP_STYLES } from './VisualPage';
import heroScreenshot from '../assets/screenshot.png';
import heroScreenshotSm from '../assets/smaller_screenshot.png';

const LoopCapture = () => (
  <div className="rhw-lv">
    {[
      { src: 'intercom', who: 'Jen K.', txt: 'Stripe portal drops session on Safari' },
      { src: 'linear',   who: 'Tomas R.', txt: 'Bulk archive in projects table' },
      { src: 'widget',   who: 'Andre B.', txt: 'Doc page returns 504 on cold start' },
    ].map((r, i) => (
      <div key={i} className="rhw-lv-row">
        <SourceIcon src={r.src} size={14} />
        <div className="rhw-lv-row-txt">{r.txt}</div>
        <div className="rhw-lv-row-who">{r.who}</div>
      </div>
    ))}
  </div>
);

const LoopAssign = () => (
  <div className="rhw-lv rhw-lv-assign">
    {[
      { task: 'Stripe portal redirect',    status: 'running',  agent: 'claude' as const, name: 'claude-sonnet-4' },
      { task: 'Bulk archive in projects',  status: 'queued',   agent: 'cursor' as const, name: 'cursor-3' },
      { task: 'Doc page 504 on cold start', status: 'standby', agent: 'codex'  as const, name: 'codex' },
    ].map((r, i) => (
      <div key={i} className="rhw-lv-assign-item">
        <div className="rhw-lv-assign-task">
          <span className="rhw-lv-assign-name">{r.task}</span>
          <span className={`rhw-lv-assign-status rhw-lv-assign-status-${r.status}`}>{r.status}</span>
        </div>
        <div className="rhw-lv-assign-agent">
          <span className="rhw-lv-assign-label">assigned to</span>
          <AgentIcon agent={r.agent} size={12} />
          <span className="rhw-lv-assign-aname">{r.name}</span>
        </div>
      </div>
    ))}
  </div>
);

const LoopReview = () => (
  <div className="rhw-lv">
    <div className="rhw-lv-pr">
      <div className="rhw-lv-pr-h">PR #4821 · portal: cross-site cookies</div>
      <div className="rhw-lv-pr-meta">+8 −3 · 1 file · 23 tests passed</div>
      <div className="rhw-lv-pr-actions">
        <span className="rhw-lv-pr-btn rhw-lv-pr-btn-on">Approve</span>
        <span className="rhw-lv-pr-btn">Request edits</span>
        <span className="rhw-lv-pr-btn">Revert</span>
      </div>
    </div>
  </div>
);

const LoopDeploy = () => (
  <div className="rhw-lv rhw-lv-mono">
    <div><strong>merge:</strong> main ← #4821</div>
    <div><strong>build:</strong> 142s · 1 file changed</div>
    <div><strong>deploy:</strong> vercel · production</div>
    <div><strong>live:</strong> portal.runhq.io · 200 OK</div>
  </div>
);

const LOOP_STAGES = [
  { n: '01', t: 'Collect feedback', s: 'Signals from anywhere',
    body: 'Ingest from Intercom, Linear, Slack, your widget, an email. Auto-dedup, severity inference, repro context attached.',
    keys: ['8 sources', '< 100ms ingest', 'PII strip at edge'],
    Visual: LoopCapture },
  { n: '02', t: 'Assign coding agents', s: 'Route to the model that fits',
    body: 'Dispatch to Claude Code, Cursor, Codex, Devin, or your own. RunHQ packages context, sets budgets, watches plateaus and re-routes between models.',
    keys: ['BYO model', 'Plateau detection', 'Auto-fallback'],
    Visual: LoopAssign },
  { n: '03', t: 'Review diff + test', s: 'Humans ship. Agents log.',
    body: 'Every change lands as a PR with full provenance. Tests run in CI before review. Approve, request edits, or revert — agents never hold merge rights.',
    keys: ['Tests in CI', 'One-click revert', 'Audit log export'],
    Visual: LoopReview },
  { n: '04', t: 'Deploy', s: 'Ship through your pipeline',
    body: 'Approved PRs flow into the deploy pipeline you already run — Vercel, Render, Fly, AWS. Every release is logged with the chain back to the original ticket.',
    keys: ['GitHub merge', 'Existing CD', 'Audit log export'],
    Visual: LoopDeploy },
];

function DemoModal({ onClose, triggerRef }: { onClose: () => void; triggerRef: React.RefObject<HTMLButtonElement | null> }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      triggerRef.current?.focus();
    };
  }, [onClose, triggerRef]);

  return (
    <div className="rhw-modal" role="dialog" aria-modal="true" aria-label="Demo video" onClick={onClose}>
      <div className="rhw-modal-frame" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="rhw-modal-close" onClick={onClose} aria-label="Close demo video">✕</button>
        <video className="rhw-modal-video" autoPlay controls playsInline src="/images/demo.mp4" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const [demoOpen, setDemoOpen] = useState(false);
  const demoBtnRef = useRef<HTMLButtonElement>(null);
  const [pipelineResetTick, setPipelineResetTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPipelineResetTick(t => t + 1), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rhw-root">
      <style>{HOME_STYLES}</style>
      <style>{VP_STYLES}</style>

      <Navbar />

      {/* HERO */}
      <section className="rhw-hero">
        <div className="rhw-hero-side">
          <h1 className="rhw-hero-h1">
            Orchestrate<br />
            AI&nbsp;Coding Agents.
          </h1>
          <p className="rhw-hero-lede">
            RunHQ lets anyone on your team assign tickets to coding agents. Each task gets its own branch, scoped and ready for review, eliminating the bottleneck between product and engineering.
          </p>
          <div className="rhw-hero-cta">
            <a className="rhw-btn-primary" href={SIGNUP_URL}>Start free <span>→</span></a>
            <button
              ref={demoBtnRef}
              type="button"
              className="rhw-btn-ghost"
              onClick={() => setDemoOpen(true)}
            >
              <span className="rhw-play">▶</span>
              Watch 90s demo
            </button>
          </div>

          <div className="rhw-hero-bullets">
            {[
              { k: 'Capture', v: 'Intercom · Linear · Slack · Widget · Email · Front · GitHub · Webhook' },
              { k: 'Execute', v: 'Claude Code · Cursor · Codex · Devin · Aider · BYO model' },
              { k: 'Ship',    v: 'GitHub · GitLab · Bitbucket — agents never hold merge rights' },
            ].map((b) => (
              <div key={b.k} className="rhw-hero-bullet">
                <div className="rhw-hero-bullet-k">{b.k}</div>
                <div className="rhw-hero-bullet-v">{b.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rhw-hero-app">
          <div className="rhw-hero-shot">
            <img src={heroScreenshot} alt="RunHQ workspace — preview improvement task" />
          </div>

          <div className="rhw-hero-shot-sm">
            <img src={heroScreenshotSm} alt="RunHQ feedback widget and latest updates" />
          </div>
        </div>
      </section>

      {/* LOGOS */}
      <section className="rhw-logos">
        <div className="rhw-logos-h">Trusted by engineering teams shipping with agents</div>
        <div className="rhw-logos-row">
          {LOGOS.map((name) => (
            <Wordmark key={name} name={name} size={18} color="var(--rhw-ink-mute)" />
          ))}
        </div>
      </section>

      {/* BEFORE / AFTER pipeline simulation */}
      <section className="rhw-pipeline">
        <div className="rhw-section-head">
          <h2 className="rhw-h2">Why teams ship faster<br />on RunHQ.</h2>
          <p className="rhw-section-deck">
            Same feedback rate into both pipelines. The human handoff chain piles up at every step. Parallel coding agents drain the queue as fast as it arrives.
          </p>
        </div>
        <div className="rhw-pipeline-grid">
          <PipelineCanvas configs={BEFORE_STATIONS} label="BEFORE" resetTick={pipelineResetTick} height={200} />
          <PipelineCanvas configs={AFTER_STATIONS} label="WITH RUNHQ" resetTick={pipelineResetTick} height={360} />
        </div>
      </section>

      {/* THE LOOP */}
      <section className="rhw-loop">
        <div className="rhw-section-head">
          <h2 className="rhw-h2">Every release walks<br />the same loop.</h2>
          <p className="rhw-section-deck">
            Most coding-agent stacks stop at &ldquo;the agent finished.&rdquo; That&rsquo;s the middle. RunHQ owns the ends — capture before, review after — so the middle can run unattended without scaring anyone.
          </p>
        </div>

        <div className="rhw-loop-grid">
          {LOOP_STAGES.map((s) => (
            <div key={s.n} className="rhw-loop-card">
              <div className="rhw-loop-card-h">
                <div className="rhw-loop-num">{s.n}</div>
                <div>
                  <div className="rhw-loop-name">{s.t}</div>
                  <div className="rhw-loop-sub">{s.s}</div>
                </div>
              </div>
              <div className="rhw-loop-visual"><s.Visual /></div>
              <p className="rhw-loop-body">{s.body}</p>
              <div className="rhw-loop-keys">
                {s.keys.map((k) => <span key={k} className="rhw-key">{k}</span>)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="rhw-cta-band">
        <div className="rhw-cta-inner">
          <h2 className="rhw-cta-h">
            Stop translating feedback by hand.<br />
            Start shipping it.
          </h2>
          <div className="rhw-cta-actions">
            <a className="rhw-btn-primary rhw-btn-lg" href={SIGNUP_URL}>Start free →</a>
            <a className="rhw-btn-ghost rhw-btn-lg" href={LOGIN_URL}>Book a 20-min demo</a>
          </div>
          <div className="rhw-cta-meta">
            <div><strong>Live in 60 minutes.</strong> Drop the widget, connect a source, ship before lunch.</div>
            <div><strong>Audit log export.</strong> PII strip at ingest. Every agent action versioned.</div>
            <div><strong>Cancel anytime.</strong> Take the audit log with you on the way out.</div>
          </div>
        </div>
      </section>

      <Footer />

      {demoOpen && <DemoModal onClose={() => setDemoOpen(false)} triggerRef={demoBtnRef} />}
    </div>
  );
}

const HOME_STYLES = `
  .rhw-root {
    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Inter Tight', system-ui, sans-serif;
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .rhw-root *, .rhw-root *::before, .rhw-root *::after { box-sizing: border-box; }
  .rhw-root a { color: inherit; text-decoration: none; }
  .rhw-root code { font-family: 'JetBrains Mono', monospace; font-size: 0.92em; background: var(--rhw-bg-2); padding: 1px 6px; border-radius: 4px; }

  /* Hero */
  .rhw-hero {
    display: grid; grid-template-columns: 1fr 1.6fr;
    gap: 48px;
    padding: 64px 48px 96px;
    border-bottom: 1px solid var(--rhw-line);
    align-items: start;
    overflow: hidden;
    background:
      radial-gradient(ellipse 80% 60% at 90% 10%, oklch(0.52 0.20 277 / 0.06), transparent 60%),
      var(--rhw-bg);
  }
  .rhw-hero-side { padding-top: 24px; max-width: 540px; }
  .rhw-hero-h1 {
    font-size: 64px; line-height: 1.02;
    letter-spacing: -0.034em; font-weight: 600;
    margin: 0 0 22px;
    color: var(--rhw-ink);
    text-wrap: balance;
  }
  .rhw-hero-lede {
    font-size: 18px; line-height: 1.55;
    color: var(--rhw-ink-soft);
    margin: 0 0 28px;
    text-wrap: pretty;
  }
  .rhw-hero-cta { display: flex; gap: 10px; margin-bottom: 36px; flex-wrap: wrap; }

  .rhw-btn-primary {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 22px;
    background: var(--rhw-ink); color: #fff !important;
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    transition: background 0.15s;
  }
  .rhw-btn-primary:hover { background: var(--rhw-accent); }
  .rhw-btn-ghost {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 20px;
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
    border-radius: 9px;
    font-size: 14px; font-weight: 500;
    transition: border-color 0.15s;
  }
  .rhw-btn-ghost:hover { border-color: var(--rhw-ink); }
  .rhw-play {
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--rhw-accent); color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 8px; padding-left: 1px;
  }
  .rhw-btn-lg { padding: 16px 28px; font-size: 15px; }

  .rhw-hero-bullets {
    display: flex; flex-direction: column;
    gap: 12px;
    padding-top: 20px;
    border-top: 1px solid var(--rhw-line);
  }
  .rhw-hero-bullet { display: grid; grid-template-columns: 80px 1fr; gap: 16px; }
  .rhw-hero-bullet-k {
    font-size: 11px; letter-spacing: 0.12em;
    color: var(--rhw-ink-mute);
    text-transform: uppercase;
    padding-top: 2px;
  }
  .rhw-hero-bullet-v { font-size: 13.5px; color: var(--rhw-ink); line-height: 1.5; }

  .rhw-hero-app {
    position: relative;
    padding-top: 14px;
    padding-bottom: 60px;
    margin-right: -120px;
    width: calc(100% + 120px);
  }

  /* App frame */
  .rhw-app {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    box-shadow: 0 30px 80px -30px rgba(20, 19, 15, 0.18), 0 6px 18px -8px rgba(20, 19, 15, 0.10);
    overflow: hidden;
  }
  .rhw-app-chrome {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px;
    background: var(--rhw-bg-2);
    border-bottom: 1px solid var(--rhw-line);
    font-size: 11.5px;
  }
  .rhw-app-dots { display: flex; gap: 6px; }
  .rhw-app-dots span {
    width: 10px; height: 10px; border-radius: 50%;
    background: #d8d2c2;
  }
  .rhw-app-title {
    margin-left: 4px;
    color: var(--rhw-ink-mute);
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }
  .rhw-app-keys {
    margin-left: auto;
    font-family: 'JetBrains Mono', monospace;
    color: var(--rhw-ink-faint);
  }
  .rhw-hero-shot { line-height: 0; }
  .rhw-hero-shot img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 12px 0 0 0;
    border: 1px solid var(--rhw-line);
    border-right: none;
    border-bottom: none;
    -webkit-mask-image: linear-gradient(to bottom,
      #000 calc(100% - 90px),
      rgba(0,0,0,0.92) calc(100% - 70px),
      rgba(0,0,0,0.72) calc(100% - 50px),
      rgba(0,0,0,0.42) calc(100% - 30px),
      rgba(0,0,0,0.16) calc(100% - 14px),
      transparent 100%);
            mask-image: linear-gradient(to bottom,
      #000 calc(100% - 90px),
      rgba(0,0,0,0.92) calc(100% - 70px),
      rgba(0,0,0,0.72) calc(100% - 50px),
      rgba(0,0,0,0.42) calc(100% - 30px),
      rgba(0,0,0,0.16) calc(100% - 14px),
      transparent 100%);
  }
  .rhw-hero-shot-sm {
    position: absolute;
    right: 60px;
    bottom: clamp(-40px, calc(-40px + (100vw - 1280px) * 0.18), 140px);
    width: 460px;
    max-width: 60%;
    line-height: 0;
    border-radius: 12px 0 0 0;
    overflow: hidden;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-right: none;
    border-bottom: none;
    -webkit-mask-image: linear-gradient(to bottom,
      #000 calc(100% - 90px),
      rgba(0,0,0,0.92) calc(100% - 70px),
      rgba(0,0,0,0.72) calc(100% - 50px),
      rgba(0,0,0,0.42) calc(100% - 30px),
      rgba(0,0,0,0.16) calc(100% - 14px),
      transparent 100%);
            mask-image: linear-gradient(to bottom,
      #000 calc(100% - 90px),
      rgba(0,0,0,0.92) calc(100% - 70px),
      rgba(0,0,0,0.72) calc(100% - 50px),
      rgba(0,0,0,0.42) calc(100% - 30px),
      rgba(0,0,0,0.16) calc(100% - 14px),
      transparent 100%);
  }
  .rhw-hero-shot-sm img {
    display: block;
    width: 100%;
    height: auto;
  }
  .rhw-app-toolbar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--rhw-line-soft);
  }
  .rhw-app-tabs { display: flex; gap: 4px; }
  .rhw-app-tab {
    padding: 4px 10px; border-radius: 6px;
    font-size: 12px; color: var(--rhw-ink-mute);
    display: inline-flex; gap: 6px; align-items: center;
  }
  .rhw-app-tab em {
    font-style: normal; font-size: 10px;
    background: var(--rhw-bg-2);
    padding: 1px 5px; border-radius: 4px;
    color: var(--rhw-ink-faint);
  }
  .rhw-app-tab-on { background: var(--rhw-bg-2); color: var(--rhw-ink); }
  .rhw-app-tab-on em { background: var(--rhw-surface); color: var(--rhw-accent); }
  .rhw-app-filter {
    margin-left: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    background: var(--rhw-bg-2);
    padding: 5px 10px;
    border-radius: 6px;
    color: var(--rhw-ink-mute);
  }
  .rhw-app-list { display: flex; flex-direction: column; }
  .rhw-app-row {
    display: flex; align-items: center; gap: 14px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rhw-line-soft);
  }
  .rhw-app-row:last-child { border-bottom: none; }
  .rhw-app-row:hover { background: var(--rhw-bg-2); }
  .rhw-app-row-l { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
  .rhw-app-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--rhw-ink-mute);
    min-width: 56px;
  }
  .rhw-app-row-meta { min-width: 0; }
  .rhw-app-row-title {
    font-size: 13.5px;
    color: var(--rhw-ink);
    margin-bottom: 2px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .rhw-app-row-sub { font-size: 11.5px; color: var(--rhw-ink-mute); }
  .rhw-app-row-r { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }

  .rhw-sev {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid;
    letter-spacing: 0.04em;
  }
  .rhw-sev-P1 { color: var(--rhw-bad); border-color: rgba(212,74,58,0.3); }
  .rhw-sev-P2 { color: var(--rhw-warn); border-color: rgba(201,140,31,0.3); }
  .rhw-sev-P3 { color: var(--rhw-ink-mute); border-color: var(--rhw-line); }

  .rhw-app-foot {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: var(--rhw-bg-2);
    border-top: 1px solid var(--rhw-line-soft);
    font-size: 11px;
    color: var(--rhw-ink-mute);
  }
  .rhw-app-foot-spacer { flex: 1; }
  .rhw-app-foot-keys { font-family: 'JetBrains Mono', monospace; }
  .rhw-live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--rhw-good);
    box-shadow: 0 0 0 3px rgba(28,139,80,0.18);
    animation: rhw-pulse 2.4s ease-in-out infinite;
    display: inline-block;
  }
  @keyframes rhw-pulse { 50% { box-shadow: 0 0 0 6px rgba(28,139,80,0.05); } }

  /* Run card */
  .rhw-run-card {
    position: absolute;
    bottom: 0;
    right: -12px;
    width: 360px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 30px 60px -20px rgba(20, 19, 15, 0.2);
  }
  .rhw-run-card-h {
    display: flex; align-items: center; gap: 10px;
    padding-bottom: 12px; margin-bottom: 12px;
    border-bottom: 1px solid var(--rhw-line-soft);
  }
  .rhw-run-card-h > div:nth-child(2) { flex: 1; min-width: 0; }
  .rhw-run-card-title { font-size: 13.5px; font-weight: 500; }
  .rhw-run-card-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; color: var(--rhw-ink-mute);
    margin-top: 2px;
  }
  .rhw-run-bars {
    display: flex; gap: 3px;
    height: 32px; align-items: flex-end;
    margin-bottom: 14px;
    padding: 0 2px;
  }
  .rhw-run-bars span {
    flex: 1;
    background: var(--rhw-accent);
    opacity: 0.8;
    border-radius: 1.5px;
  }
  .rhw-run-card-row {
    display: flex; align-items: center; gap: 10px;
    font-size: 12.5px;
    color: var(--rhw-ink-mute);
    padding: 4px 0;
  }
  .rhw-run-card-active { color: var(--rhw-ink); font-weight: 500; }
  .rhw-run-step {
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--rhw-bg-2);
    color: var(--rhw-accent);
    font-size: 10px; font-weight: 600;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .rhw-run-step-done { background: var(--rhw-good); color: #fff; }

  /* Logos */
  .rhw-logos {
    padding: 36px 48px;
    border-bottom: 1px solid var(--rhw-line);
    text-align: center;
  }
  .rhw-logos-h {
    font-size: 12px; letter-spacing: 0.06em;
    color: var(--rhw-ink-mute);
    margin-bottom: 22px;
  }
  .rhw-logos-row {
    display: flex; gap: 38px; flex-wrap: wrap;
    justify-content: center; align-items: center;
  }

  /* Section heads */
  .rhw-section-head {
    padding: 80px 48px 36px;
    max-width: 880px;
  }
  .rhw-eyebrow {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 4px 12px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 999px;
    font-size: 12px;
    color: var(--rhw-accent);
    margin-bottom: 16px;
    font-weight: 500;
  }
  .rhw-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--rhw-accent);
    box-shadow: 0 0 0 4px var(--rhw-accent-soft);
  }
  .rhw-h2 {
    font-size: 56px; line-height: 1.04;
    letter-spacing: -0.03em; font-weight: 600;
    margin: 0 0 16px;
    color: var(--rhw-ink);
    text-wrap: balance;
  }
  .rhw-section-deck {
    font-size: 18px; line-height: 1.55;
    color: var(--rhw-ink-soft);
    margin: 0;
    max-width: 640px;
    text-wrap: pretty;
  }

  /* Demo modal */
  .rhw-modal {
    position: fixed; inset: 0;
    background: rgba(20, 19, 15, 0.78);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 32px;
    z-index: 1000;
    animation: rhw-modal-fade 0.18s ease-out;
  }
  @keyframes rhw-modal-fade { from { opacity: 0; } to { opacity: 1; } }
  .rhw-modal-frame {
    position: relative;
    width: 100%; max-width: 960px;
    aspect-ratio: 16 / 9;
    background: #000;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.6);
  }
  .rhw-modal-close {
    position: absolute; top: -42px; right: 0;
    width: 32px; height: 32px;
    background: transparent;
    color: rgba(255,255,255,0.85);
    border: none;
    font-size: 18px;
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
  }
  .rhw-modal-close:hover { background: rgba(255,255,255,0.12); color: #fff; }
  .rhw-modal-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .rhw-modal-video { width: 100%; height: 100%; display: block; }

  /* Before / After pipeline simulation */
  .rhw-pipeline { padding-bottom: 80px; }
  .rhw-pipeline-grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 0 48px;
    max-width: 1200px;
    margin: 0 auto;
  }
  @media (max-width: 768px) {
    .rhw-pipeline-grid { padding: 0 16px; }
  }

  .rhw-loop {
    background: var(--rhw-bg-2);
    border-top: 1px solid var(--rhw-line);
    border-bottom: 1px solid var(--rhw-line);
    padding-bottom: 80px;
  }
  .rhw-loop-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    padding: 0 48px;
  }
  .rhw-loop-card {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    padding: 24px 22px 22px;
    display: flex; flex-direction: column;
    gap: 14px;
  }
  .rhw-loop-card-h { display: flex; gap: 14px; align-items: center; }
  .rhw-loop-num {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    width: 36px; height: 36px;
    border-radius: 8px;
    background: var(--rhw-accent-soft);
    color: var(--rhw-accent);
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 600;
    flex-shrink: 0;
  }
  .rhw-loop-name { font-size: 18px; font-weight: 600; letter-spacing: -0.015em; }
  .rhw-loop-sub { font-size: 12px; color: var(--rhw-ink-mute); margin-top: 2px; }
  .rhw-loop-visual {
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 10px;
    padding: 12px;
    height: 140px;
    overflow: hidden;
    font-size: 11.5px;
  }
  .rhw-loop-body { font-size: 13.5px; line-height: 1.55; color: var(--rhw-ink-soft); margin: 0; }
  .rhw-loop-keys { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
  .rhw-key {
    font-size: 10.5px;
    padding: 3px 8px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    border-radius: 999px;
    color: var(--rhw-ink-soft);
  }

  /* Loop visuals */
  .rhw-lv { display: flex; flex-direction: column; gap: 6px; height: 100%; }
  .rhw-lv-row {
    display: flex; align-items: center; gap: 8px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 6px;
    padding: 6px 8px;
  }
  .rhw-lv-row-txt { flex: 1; font-size: 11.5px; color: var(--rhw-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rhw-lv-row-who { font-size: 10.5px; color: var(--rhw-ink-mute); }
  .rhw-lv-mono { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--rhw-ink); line-height: 1.7; }
  .rhw-lv-mono strong { color: var(--rhw-accent); font-weight: 500; }
  .rhw-lv-bar { height: 6px; background: var(--rhw-line-soft); border-radius: 3px; overflow: hidden; }
  .rhw-lv-bar > span {
    display: block; height: 100%;
    background: var(--rhw-accent);
    animation: rhw-bar 4s ease-in-out infinite;
  }
  @keyframes rhw-bar { 0%, 100% { width: 35%; } 50% { width: 92%; } }
  .rhw-lv-exec-row {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; color: var(--rhw-ink); margin-top: 2px;
  }
  .rhw-lv-exec-row span { color: var(--rhw-ink-mute); margin-left: auto; font-family: 'JetBrains Mono', monospace; font-size: 10px; }

  .rhw-lv-assign { gap: 10px; }
  .rhw-lv-assign-item { display: flex; flex-direction: column; gap: 3px; }
  .rhw-lv-assign-task {
    display: flex; align-items: center; gap: 8px;
    font-size: 11.5px; color: var(--rhw-ink);
  }
  .rhw-lv-assign-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rhw-lv-assign-status {
    font-family: 'JetBrains Mono', monospace; font-size: 9.5px;
    padding: 1px 6px; border-radius: 3px;
    background: var(--rhw-bg-2); color: var(--rhw-ink-mute);
    text-transform: lowercase; letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  .rhw-lv-assign-status-running { background: oklch(0.92 0.10 145 / 0.5); color: var(--rhw-good); }
  .rhw-lv-assign-status-queued  { background: oklch(0.92 0.08 85  / 0.5); color: oklch(0.45 0.12 65); }
  .rhw-lv-assign-status-standby { background: var(--rhw-bg-2); color: var(--rhw-ink-mute); }
  .rhw-lv-assign-agent {
    display: flex; align-items: center; gap: 6px;
    padding-left: 14px;
    font-size: 10.5px; color: var(--rhw-ink-mute);
  }
  .rhw-lv-assign-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; }
  .rhw-lv-assign-aname { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--rhw-ink); }
  .rhw-lv-pr {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 8px;
    padding: 10px;
  }
  .rhw-lv-pr-h { font-size: 12px; font-weight: 500; margin-bottom: 4px; }
  .rhw-lv-pr-meta { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--rhw-ink-mute); margin-bottom: 8px; }
  .rhw-lv-pr-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .rhw-lv-pr-btn {
    font-size: 10px;
    padding: 3px 8px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 4px;
    color: var(--rhw-ink-soft);
  }
  .rhw-lv-pr-btn-on { background: var(--rhw-good); color: #fff; border-color: var(--rhw-good); }

  /* Integrations */
  .rhw-int { padding-bottom: 80px; }
  .rhw-int-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    padding: 0 48px;
  }
  .rhw-int-col {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    padding: 22px 22px 18px;
  }
  .rhw-int-h {
    font-size: 11px; letter-spacing: 0.16em;
    color: var(--rhw-accent);
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--rhw-line-soft);
    text-transform: uppercase;
  }
  .rhw-int-list { display: flex; flex-direction: column; gap: 8px; }
  .rhw-int-i {
    display: flex; align-items: center; gap: 10px;
    font-size: 13.5px; color: var(--rhw-ink);
    padding: 4px 0;
  }
  .rhw-int-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--rhw-ink-faint);
  }

  /* CTA */
  .rhw-cta-band {
    margin: 0 48px 56px;
    background: var(--rhw-ink);
    color: #fff;
    border-radius: 24px;
    padding: 80px 48px;
    overflow: hidden;
    position: relative;
  }
  .rhw-cta-band::before {
    content: '';
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 60% 80% at 50% 0%, oklch(0.55 0.20 277 / 0.5), transparent 60%);
    pointer-events: none;
  }
  .rhw-cta-inner { text-align: center; position: relative; }
  .rhw-cta-eyebrow {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 5px 14px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.16);
    border-radius: 999px;
    font-size: 12px;
    margin-bottom: 22px;
  }
  .rhw-cta-h {
    font-size: 64px; line-height: 1.04;
    letter-spacing: -0.03em; font-weight: 600;
    margin: 0 auto 32px;
    max-width: 1000px;
    text-wrap: balance;
  }
  .rhw-cta-actions { display: inline-flex; gap: 12px; margin-bottom: 36px; flex-wrap: wrap; justify-content: center; }
  .rhw-cta-band .rhw-btn-primary { background: #fff; color: var(--rhw-ink) !important; }
  .rhw-cta-band .rhw-btn-primary:hover { background: oklch(0.85 0.18 145); }
  .rhw-cta-band .rhw-btn-ghost {
    background: transparent; color: #fff !important;
    border-color: rgba(255,255,255,0.3);
  }
  .rhw-cta-band .rhw-btn-ghost:hover { border-color: #fff; }
  .rhw-cta-meta {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 32px;
    max-width: 1000px;
    margin: 0 auto;
    padding-top: 36px;
    border-top: 1px solid rgba(255,255,255,0.12);
    text-align: left;
  }
  .rhw-cta-meta div { font-size: 13.5px; line-height: 1.5; color: rgba(255,255,255,0.7); }
  .rhw-cta-meta strong { color: #fff; font-weight: 500; display: block; margin-bottom: 4px; }

  /* Responsive */
  @media (max-width: 1100px) {
    .rhw-hero { grid-template-columns: 1fr; padding: 48px 32px 64px; gap: 36px; }
    .rhw-hero-app { margin-right: 0; width: 100%; padding-bottom: 80px; }
    .rhw-run-card { right: 0; }
    .rhw-section-head { padding: 64px 32px 28px; }
    .rhw-loop-grid { grid-template-columns: repeat(2, 1fr); padding: 0 32px; }
    .rhw-int-grid { grid-template-columns: repeat(2, 1fr); padding: 0 32px; }
    .rhw-cta-band { margin: 0 32px 48px; padding: 56px 28px; }
    .rhw-cta-h { font-size: 40px; }
    .rhw-cta-meta { grid-template-columns: 1fr; gap: 16px; }
    .rhw-modal { padding: 16px; }
    .rhw-modal-close { top: -36px; }
  }
  @media (max-width: 720px) {
    .rhw-hero-h1 { font-size: 44px; }
    .rhw-h2 { font-size: 36px; }
    .rhw-loop-grid, .rhw-int-grid { grid-template-columns: 1fr; }
    .rhw-run-card { width: 100%; right: 0; }
    .rhw-cta-h { font-size: 32px; }
  }
`;
