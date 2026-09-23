import { useEffect, useRef, useState } from 'react';
import { Navbar, Footer, Avatar, AgentIcon, SourceIcon, Wordmark, LOGOS, LOGIN_URL } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { trackSignInClick } from '../telemetry';
import { PipelineCanvas, BEFORE_STATIONS, AFTER_STATIONS, VP_STYLES } from './VisualPage';
import { useT, useLocale, useLocalePath } from '../i18n/context';
import { useSurface } from '../evolve/surface';
import { SurfaceBlock } from '../evolve/SurfaceBlock';
import { HOME_SURFACES, surfaceKey } from './homeSurfaces';
import { API_BASE } from '../widget';
import heroScreenshot from '../assets/screenshot.png';
import heroScreenshotSm from '../assets/smaller_screenshot.png';
import arrrCover from '../assets/arrr-cover.jpg';
import { HOME_T } from './homeCopy';


/**
 * Live stats for the "Real projects" showcase, pulled from the public board API
 * (same host the widget talks to). Two unauthenticated GETs on mount:
 *   - `/api/widget/projects` → total ticket counts for every card (one call).
 *   - `/api/widget/home-stats` w/ `X-RW-Project: arrr` → the hero's weekly numbers.
 * Credentials are omitted (public data), and state seeds with the fallbacks below
 * so first paint, localhost dev (CORS blocks the fetch there), and any failure all
 * render sensible numbers. See the design spec under docs/superpowers/specs.
 */
const SHOWCASE_FALLBACK = {
  arrr: { ticketsWeek: 500, contributors: 130, deploysWeek: 100, ticketsTotal: 650 },
  runhq: { ticketsTotal: 60 },
  moddio: { ticketsTotal: 20 },
} as const;

type ShowcaseStats = {
  arrr: { ticketsWeek: number; contributors: number; deploysWeek: number };
  totals: { arrr: number; runhq: number; moddio: number };
};

function useBoardStats(): ShowcaseStats {
  const [stats, setStats] = useState<ShowcaseStats>({
    arrr: {
      ticketsWeek: SHOWCASE_FALLBACK.arrr.ticketsWeek,
      contributors: SHOWCASE_FALLBACK.arrr.contributors,
      deploysWeek: SHOWCASE_FALLBACK.arrr.deploysWeek,
    },
    totals: {
      arrr: SHOWCASE_FALLBACK.arrr.ticketsTotal,
      runhq: SHOWCASE_FALLBACK.runhq.ticketsTotal,
      moddio: SHOWCASE_FALLBACK.moddio.ticketsTotal,
    },
  });

  useEffect(() => {
    const ctrl = new AbortController();
    const opts: RequestInit = { signal: ctrl.signal, credentials: 'omit' };

    // Total ticket counts for all cards in one call.
    fetch(`${API_BASE}/api/widget/projects`, opts)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: { projects?: Array<{ slug: string; ticketCount: number }> }) => {
        const bySlug = new Map((data.projects ?? []).map((p) => [p.slug, p.ticketCount]));
        setStats((s) => ({
          ...s,
          totals: {
            arrr: bySlug.get('arrr') ?? s.totals.arrr,
            runhq: bySlug.get('runhq') ?? s.totals.runhq,
            moddio: bySlug.get('moddio') ?? s.totals.moddio,
          },
        }));
      })
      .catch(() => {/* keep fallbacks */});

    // Rich weekly stats for the ARRR hero.
    fetch(`${API_BASE}/api/widget/home-stats`, { ...opts, headers: { 'X-RW-Project': 'arrr' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { ticketsCreated7d?: number; activeContributors7d?: number; dailyDeployVolume?: Array<{ count?: number }> }) => {
        const deploysWeek = (d.dailyDeployVolume ?? []).reduce((n, x) => n + (x.count ?? 0), 0);
        setStats((s) => ({
          ...s,
          arrr: {
            ticketsWeek: d.ticketsCreated7d ?? s.arrr.ticketsWeek,
            contributors: d.activeContributors7d ?? s.arrr.contributors,
            deploysWeek: deploysWeek || s.arrr.deploysWeek,
          },
        }));
      })
      .catch(() => {/* keep fallbacks */});

    return () => ctrl.abort();
  }, []);

  return stats;
}

function DemoModal({ onClose, triggerRef }: { onClose: () => void; triggerRef: React.RefObject<HTMLButtonElement | null> }) {
  const t = useT(HOME_T);
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
    <div className="rhw-modal" role="dialog" aria-modal="true" aria-label={t.modalAriaLabel} onClick={onClose}>
      <div className="rhw-modal-frame" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="rhw-modal-close" onClick={onClose} aria-label={t.modalCloseLabel}>✕</button>
        <video className="rhw-modal-video" autoPlay controls playsInline src="/images/demo.mp4" />
      </div>
    </div>
  );
}

export default function HomePage() {
  const t = useT(HOME_T);
  // Evolve surfaces: latched once read with the tracker on (see evolve/surface.ts). `hero` and
  // `closing` replace `t` for exactly the fields the surfaces own.
  const locale = useLocale();
  const hero = useSurface(surfaceKey('home.hero', locale), HOME_SURFACES.hero[locale]);
  const closing = useSurface(surfaceKey('home.closing', locale), HOME_SURFACES.closing[locale]);
  const lp = useLocalePath();
  // lp is wired up for any future internal links; current CTAs use external auth URLs.
  void lp;
  const [demoOpen, setDemoOpen] = useState(false);
  const demoBtnRef = useRef<HTMLButtonElement>(null);
  const [pipelineResetTick, setPipelineResetTick] = useState(0);
  const boardStats = useBoardStats();

  useEffect(() => {
    const id = setInterval(() => setPipelineResetTick(tick => tick + 1), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const LoopCapture = () => (
    <div className="rhw-lv">
      {[
        { src: 'intercom', who: t.captureWho1, txt: t.captureTxt1 },
        { src: 'linear',   who: t.captureWho2, txt: t.captureTxt2 },
        { src: 'widget',   who: t.captureWho3, txt: t.captureTxt3 },
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
        { task: t.assignTask1, statusKey: 'running' as const, statusLabel: t.assignStatusRunning, agent: 'claude' as const, name: 'claude-sonnet-4' },
        { task: t.assignTask2, statusKey: 'queued'  as const, statusLabel: t.assignStatusQueued,  agent: 'cursor' as const, name: 'cursor-3' },
        { task: t.assignTask3, statusKey: 'standby' as const, statusLabel: t.assignStatusStandby, agent: 'codex'  as const, name: 'codex' },
      ].map((r, i) => (
        <div key={i} className="rhw-lv-assign-item">
          <div className="rhw-lv-assign-task">
            <span className="rhw-lv-assign-name">{r.task}</span>
            <span className={`rhw-lv-assign-status rhw-lv-assign-status-${r.statusKey}`}>{r.statusLabel}</span>
          </div>
          <div className="rhw-lv-assign-agent">
            <span className="rhw-lv-assign-label">{t.assignLabel}</span>
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
        <div className="rhw-lv-pr-h">{t.reviewPrH}</div>
        <div className="rhw-lv-pr-meta">{t.reviewPrMeta}</div>
        <div className="rhw-lv-pr-actions">
          <span className="rhw-lv-pr-btn rhw-lv-pr-btn-on">{t.reviewBtnApprove}</span>
          <span className="rhw-lv-pr-btn">{t.reviewBtnRequest}</span>
          <span className="rhw-lv-pr-btn">{t.reviewBtnRevert}</span>
        </div>
      </div>
    </div>
  );

  const LoopDeploy = () => (
    <div className="rhw-lv rhw-lv-mono">
      <div><strong>{t.deployPreviewLabel}</strong> {t.deployPreviewV}</div>
      <div><strong>{t.deployTestsLabel}</strong> {t.deployTestsV}</div>
      <div><strong>{t.deployDeployLabel}</strong> {t.deployDeployV}</div>
      <div><strong>{t.deployLiveLabel}</strong> {t.deployLiveV}</div>
    </div>
  );

  const LOOP_STAGES = [
    { n: '01', t: t.loop1Title, s: t.loop1Sub,
      body: t.loop1Body,
      keys: [t.loop1Key1, t.loop1Key2, t.loop1Key3],
      Visual: LoopCapture },
    { n: '02', t: t.loop2Title, s: t.loop2Sub,
      body: t.loop2Body,
      keys: [t.loop2Key1, t.loop2Key2, t.loop2Key3],
      Visual: LoopAssign },
    { n: '03', t: t.loop3Title, s: t.loop3Sub,
      body: t.loop3Body,
      keys: [t.loop3Key1, t.loop3Key2, t.loop3Key3],
      Visual: LoopReview },
    { n: '04', t: t.loop4Title, s: t.loop4Sub,
      body: t.loop4Body,
      keys: [t.loop4Key1, t.loop4Key2, t.loop4Key3],
      Visual: LoopDeploy },
  ];

  return (
    <div className="rhw-root">
      <style>{HOME_STYLES}</style>
      <style>{VP_STYLES}</style>

      <Navbar />

      {/* HERO */}
      <section className="rhw-hero">
        <SurfaceBlock className="rhw-hero-side" settled={hero.settled}>
          <h1 className="rhw-hero-h1">
            {hero.value.heroH1Line1} {hero.value.heroH1Line2}
          </h1>
          <p className="rhw-hero-lede">
            {hero.value.heroLede}
          </p>
          <div className="rhw-hero-cta">
            <TalkToUsButton className="rhw-btn-primary" cta="hero">{hero.value.ctaStartFree} <span>→</span></TalkToUsButton>
            <button
              ref={demoBtnRef}
              type="button"
              className="rhw-btn-ghost"
              onClick={() => setDemoOpen(true)}
            >
              <span className="rhw-play">▶</span>
              {hero.value.ctaWatchDemo}
            </button>
          </div>

        </SurfaceBlock>

        <div className="rhw-hero-app">
          <div className="rhw-hero-shot">
            <img src={heroScreenshot} alt={t.heroScreenshotAlt} />
          </div>

          <div className="rhw-hero-shot-sm">
            <img src={heroScreenshotSm} alt={t.heroScreenshotSmAlt} />
          </div>
        </div>
      </section>

      {/* LOGOS */}
      <section className="rhw-logos">
        <div className="rhw-logos-h">{t.logosH}</div>
        <div className="rhw-logos-row">
          {LOGOS.map((name) => (
            <Wordmark key={name} name={name} size={18} color="var(--rhw-ink-mute)" />
          ))}
        </div>
      </section>

      {/* BEFORE / AFTER pipeline simulation */}
      <section className="rhw-pipeline">
        <div className="rhw-section-head">
          <h2 className="rhw-h2">{t.pipelineH2Line1}<br />{t.pipelineH2Line2}</h2>
          <p className="rhw-section-deck">
            {t.pipelineDeck}
          </p>
        </div>
        <div className="rhw-pipeline-grid">
          <PipelineCanvas configs={BEFORE_STATIONS} label={t.pipelineLabelBefore} resetTick={pipelineResetTick} height={200} />
          <PipelineCanvas configs={AFTER_STATIONS} label={t.pipelineLabelAfter} resetTick={pipelineResetTick} height={360} />
        </div>
      </section>

      {/* THE LOOP */}
      <section className="rhw-loop">
        <div className="rhw-section-head">
          <h2 className="rhw-h2">{t.loopH2Line1}<br />{t.loopH2Line2}</h2>
          <p className="rhw-section-deck">
            {t.loopDeck}
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

      {/* SHOWCASE — real, live project boards */}
      <section className="rhw-showcase">
        <div className="rhw-section-head">
          <div className="rhw-eyebrow"><span className="rhw-dot" />{t.showcaseEyebrow}</div>
          <h2 className="rhw-h2">{t.showcaseH2Line1}<br />{t.showcaseH2Line2}</h2>
          <p className="rhw-section-deck">{t.showcaseDeck}</p>
        </div>

        <div className="rhw-showcase-grid">
          {/* Hero — ARRR */}
          <a className="rhw-sc-card rhw-sc-hero" href="/arrr">
            <img className="rhw-sc-hero-art" src={arrrCover} alt={t.showcaseArrrArtAlt} loading="lazy" />
            <div className="rhw-sc-hero-body">
              <div>
                <div className="rhw-sc-top">
                  <div className="rhw-sc-name">{t.showcaseArrrName}</div>
                  <span className="rhw-sc-live"><span className="rhw-live-dot" />{t.showcaseLive}</span>
                </div>
                <p className="rhw-sc-tagline">{t.showcaseArrrTagline}</p>
              </div>
              <div className="rhw-sc-stats">
                <div className="rhw-sc-stat">
                  <div className="rhw-sc-stat-n">{boardStats.arrr.ticketsWeek.toLocaleString()}</div>
                  <div className="rhw-sc-stat-l">{t.showcaseStatTicketsWeek}</div>
                </div>
                <div className="rhw-sc-stat">
                  <div className="rhw-sc-stat-n">{boardStats.arrr.contributors.toLocaleString()}</div>
                  <div className="rhw-sc-stat-l">{t.showcaseStatContributors}</div>
                </div>
                <div className="rhw-sc-stat">
                  <div className="rhw-sc-stat-n">{boardStats.arrr.deploysWeek.toLocaleString()}</div>
                  <div className="rhw-sc-stat-l">{t.showcaseStatDeploysWeek}</div>
                </div>
              </div>
              <span className="rhw-sc-open rhw-sc-open-primary">{t.showcaseOpenBoard} <span>→</span></span>
            </div>
          </a>

          {/* Secondary — RunHQ, Moddio */}
          <div className="rhw-sc-side">
            <a className="rhw-sc-card rhw-sc-sm" href="/runhq">
              <div className="rhw-sc-name">{t.showcaseRunhqName}</div>
              <p className="rhw-sc-tagline">{t.showcaseRunhqTagline}</p>
              <div className="rhw-sc-sm-foot">
                <span className="rhw-sc-sm-stat"><strong>{boardStats.totals.runhq.toLocaleString()}</strong> {t.showcaseStatTicketsTotal}</span>
                <span className="rhw-sc-open">{t.showcaseOpen} <span>→</span></span>
              </div>
            </a>
            <a className="rhw-sc-card rhw-sc-sm" href="/moddio">
              <div className="rhw-sc-name">{t.showcaseModdioName}</div>
              <p className="rhw-sc-tagline">{t.showcaseModdioTagline}</p>
              <div className="rhw-sc-sm-foot">
                <span className="rhw-sc-sm-stat"><strong>{boardStats.totals.moddio.toLocaleString()}</strong> {t.showcaseStatTicketsTotal}</span>
                <span className="rhw-sc-open">{t.showcaseOpen} <span>→</span></span>
              </div>
            </a>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="rhw-cta-band">
        <SurfaceBlock className="rhw-cta-inner" settled={closing.settled}>
          <h2 className="rhw-cta-h">
            {closing.value.ctaH1}<br />
            {closing.value.ctaH2}
          </h2>
          <div className="rhw-cta-actions">
            <TalkToUsButton className="rhw-btn-primary rhw-btn-lg" cta="home_closing">{closing.value.ctaBtnPrimary}</TalkToUsButton>
            <a
              className="rhw-btn-ghost rhw-btn-lg"
              href={LOGIN_URL}
              onClick={() => trackSignInClick('home_closing')}
            >{t.ctaBtnSecondary}</a>
          </div>
          <div className="rhw-cta-meta">
            <div><strong>{t.ctaMeta1Strong}</strong> {t.ctaMeta1}</div>
            <div><strong>{t.ctaMeta2Strong}</strong> {t.ctaMeta2}</div>
            <div><strong>{t.ctaMeta3Strong}</strong> {t.ctaMeta3}</div>
          </div>
        </SurfaceBlock>
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
  .rhw-hero-side { padding-top: 24px; max-width: 600px; }
  .rhw-hero-h1 {
    font-size: clamp(44px, 4.6vw, 56px); line-height: 1.05;
    letter-spacing: -0.032em; font-weight: 600;
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

  /* Showcase — live boards */
  .rhw-showcase { padding-bottom: 80px; }
  .rhw-showcase-grid {
    display: grid; grid-template-columns: 1.4fr 1fr;
    gap: 14px;
    padding: 0 48px;
    align-items: stretch;
  }
  .rhw-sc-card {
    display: flex; flex-direction: column;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    padding: 26px 24px;
    color: inherit;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .rhw-sc-card:hover {
    border-color: var(--rhw-accent);
    transform: translateY(-2px);
    box-shadow: 0 24px 56px -28px rgba(20, 19, 15, 0.24);
  }
  .rhw-sc-hero { flex-direction: row; padding: 0; gap: 0; overflow: hidden; }
  .rhw-sc-hero-art {
    flex: 0 0 42%;
    align-self: stretch;
    width: 42%;
    object-fit: cover;
    object-position: center;
    display: block;
    border-right: 1px solid var(--rhw-line);
    background: var(--rhw-bg-2);
  }
  .rhw-sc-hero-body {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column;
    justify-content: space-between;
    gap: 24px;
    padding: 26px 24px;
  }
  .rhw-sc-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .rhw-sc-name { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .rhw-sc-hero .rhw-sc-name { font-size: 28px; }
  .rhw-sc-live {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px; color: var(--rhw-good);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .rhw-sc-tagline {
    font-size: 14px; line-height: 1.55;
    color: var(--rhw-ink-soft);
    margin: 10px 0 0;
    text-wrap: pretty;
  }
  .rhw-sc-hero .rhw-sc-tagline { font-size: 15px; max-width: 480px; }
  .rhw-sc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .rhw-sc-stat {
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 10px;
    padding: 16px 14px;
  }
  .rhw-sc-stat-n {
    font-size: 30px; font-weight: 600; letter-spacing: -0.02em;
    line-height: 1; color: var(--rhw-ink);
    font-variant-numeric: tabular-nums;
  }
  .rhw-sc-stat-l { font-size: 12px; color: var(--rhw-ink-mute); margin-top: 6px; }
  .rhw-sc-open {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 13px; font-weight: 500;
    color: var(--rhw-accent) !important;
  }
  .rhw-sc-open span { transition: transform 0.15s; }
  .rhw-sc-card:hover .rhw-sc-open span { transform: translateX(3px); }
  .rhw-sc-open-primary {
    align-self: flex-start;
    padding: 11px 18px;
    background: var(--rhw-ink);
    color: #fff !important;
    border-radius: 9px;
    font-size: 14px;
    transition: background 0.15s;
  }
  .rhw-sc-hero:hover .rhw-sc-open-primary { background: var(--rhw-accent); }
  .rhw-sc-side { display: flex; flex-direction: column; gap: 14px; }
  .rhw-sc-sm { flex: 1; }
  .rhw-sc-sm-foot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-top: auto; padding-top: 18px;
  }
  .rhw-sc-sm-stat { font-size: 12.5px; color: var(--rhw-ink-mute); }
  .rhw-sc-sm-stat strong { color: var(--rhw-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
  @media (max-width: 1100px) {
    .rhw-showcase-grid { grid-template-columns: 1fr; padding: 0 32px; }
  }
  @media (max-width: 720px) {
    .rhw-sc-stats { gap: 8px; }
    .rhw-sc-stat { padding: 13px 10px; }
    .rhw-sc-stat-n { font-size: 24px; }
    .rhw-sc-hero .rhw-sc-name { font-size: 24px; }
    .rhw-sc-hero { flex-direction: column; }
    .rhw-sc-hero-art {
      width: 100%; flex-basis: auto;
      height: 200px;
      object-position: center 42%;
      border-right: none;
      border-bottom: 1px solid var(--rhw-line);
    }
  }

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
