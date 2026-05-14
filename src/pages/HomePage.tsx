import { useEffect, useRef, useState } from 'react';
import { Navbar, Footer, Avatar, AgentIcon, SourceIcon, Wordmark, LOGOS, SIGNUP_URL, LOGIN_URL } from '../components/chrome';
import { PipelineCanvas, BEFORE_STATIONS, AFTER_STATIONS, VP_STYLES } from './VisualPage';
import { useT, useLocalePath } from '../i18n/context';
import heroScreenshot from '../assets/screenshot.png';
import heroScreenshotSm from '../assets/smaller_screenshot.png';

const HOME_T = {
  en: {
    // Hero
    heroH1Line1: 'Agentic automation for',
    heroH1Line2: 'fast-moving founders.',
    heroLede: 'RunHQ lets anyone on your team hand off work to agents. Research, ops, code, and beyond.',
    ctaStartFree: 'Start free',
    ctaWatchDemo: 'Watch Demo',
    heroScreenshotAlt: 'RunHQ workspace — preview improvement task',
    heroScreenshotSmAlt: 'RunHQ feedback widget and latest updates',
    // Hero roles
    // Logos
    logosH: 'Trusted by engineering teams shipping with agents',
    // Pipeline section
    pipelineH2Line1: 'Why teams ship faster',
    pipelineH2Line2: 'on RunHQ.',
    pipelineDeck: 'Same feedback rate into both pipelines. The human handoff chain piles up at every step. Parallel coding agents drain the queue as fast as it arrives.',
    pipelineLabelBefore: 'BEFORE',
    pipelineLabelAfter: 'WITH RUNHQ',
    // Loop section
    loopH2Line1: 'Every release walks',
    loopH2Line2: 'the same loop.',
    loopDeck: 'Most coding-agent stacks stop at “the agent finished.” That’s the middle. RunHQ owns the ends — capture before, review after — so the middle can run unattended without scaring anyone.',
    // Loop stage 01 — Collect feedback
    loop1Title: 'Collect feedback',
    loop1Sub: 'One widget, no extra login.',
    loop1Body: 'Users and teammates send feedback straight from your product through an embedded widget — no separate account, no login wall. Each report lands in RunHQ with the page, the user, and repro context attached.',
    loop1Key1: 'Embedded widget',
    loop1Key2: 'No login wall',
    loop1Key3: 'Auto-context',
    // Loop stage 02 — Assign coding agents
    loop2Title: 'Assign coding agents',
    loop2Sub: 'Run them in parallel.',
    loop2Body: 'Assign tasks to your custom agents equipped with Claude Code, Cursor, Codex, or your own. RunHQ spawns processes in parallel while logging the important details for full transparency.',
    loop2Key1: 'BYO agent',
    loop2Key2: 'Parallel runs',
    loop2Key3: 'Full audit log',
    // Loop stage 03 — Review code
    loop3Title: 'Review code',
    loop3Sub: 'PRs land ready to read.',
    loop3Body: 'Every agent run lands as a clean pull request with diff, summary, and provenance attached — so reviewers can scan, comment, and approve in the GitHub flow they already use.',
    loop3Key1: 'GitHub PRs',
    loop3Key2: 'Inline diff',
    loop3Key3: 'One-click revert',
    // Loop stage 04 — Test + Deploy
    loop4Title: 'Test + Deploy',
    loop4Sub: 'Run the app before you ship.',
    loop4Body: 'RunHQ spins up a fully functioning server for every PR — its own URL, its own environment — so you can actually exercise the change end-to-end before it merges into the deploy pipeline you already run.',
    loop4Key1: 'Live preview env',
    loop4Key2: 'Per-PR sandbox',
    loop4Key3: 'Ships via your CD',
    // LoopCapture demo rows
    captureWho1: 'Jen K.',
    captureTxt1: 'Stripe portal drops session on Safari',
    captureWho2: 'Tomas R.',
    captureTxt2: 'Bulk archive in projects table',
    captureWho3: 'Andre B.',
    captureTxt3: 'Doc page returns 504 on cold start',
    // LoopAssign demo rows
    assignTask1: 'Stripe portal redirect',
    assignTask2: 'Bulk archive in projects',
    assignTask3: 'Doc page 504 on cold start',
    assignStatusRunning: 'running',
    assignStatusQueued: 'queued',
    assignStatusStandby: 'standby',
    assignLabel: 'assigned to',
    // LoopReview demo
    reviewPrH: 'PR #4821 · portal: cross-site cookies',
    reviewPrMeta: '+8 −3 · 1 file changed · ready for review',
    reviewBtnApprove: 'Approve',
    reviewBtnRequest: 'Request edits',
    reviewBtnRevert: 'Revert',
    // LoopDeploy demo
    deployPreviewLabel: 'preview:',
    deployPreviewV: 'pr-4821.runhq.dev · ready',
    deployTestsLabel: 'tests:',
    deployTestsV: '23 passed · 142s',
    deployDeployLabel: 'deploy:',
    deployDeployV: 'vercel · production',
    deployLiveLabel: 'live:',
    deployLiveV: 'portal.runhq.io · 200 OK',
    // CTA band
    ctaH1: 'Stop translating feedback by hand.',
    ctaH2: 'Start shipping it.',
    ctaBtnPrimary: 'Start free →',
    ctaBtnSecondary: 'Book a 20-min demo',
    ctaMeta1Strong: 'Live in 60 minutes.',
    ctaMeta1: 'Drop the widget, connect a source, ship before lunch.',
    ctaMeta2Strong: 'Audit log export.',
    ctaMeta2: 'PII strip at ingest. Every agent action versioned.',
    ctaMeta3Strong: 'Cancel anytime.',
    ctaMeta3: 'Take the audit log with you on the way out.',
    // Modal
    modalAriaLabel: 'Demo video',
    modalCloseLabel: 'Close demo video',
  },
  ko: {
    // Hero
    heroH1Line1: '빠르게 움직이는 창업자를 위한',
    heroH1Line2: '에이전트 자동화.',
    heroLede: 'RunHQ는 팀 누구나 에이전트에게 일을 맡길 수 있게 해줍니다. 리서치, 운영, 코드, 그 외 무엇이든.',
    ctaStartFree: '무료로 시작하기',
    ctaWatchDemo: '데모 보기',
    heroScreenshotAlt: 'RunHQ 워크스페이스 — 개선 작업 미리보기',
    heroScreenshotSmAlt: 'RunHQ 피드백 위젯과 최신 업데이트',
    // Hero roles
    // Logos
    logosH: '에이전트와 함께 배포하는 엔지니어링 팀들이 신뢰합니다',
    // Pipeline section
    pipelineH2Line1: 'RunHQ에서 팀이',
    pipelineH2Line2: '더 빠르게 배포하는 이유.',
    pipelineDeck: '두 파이프라인에 같은 속도로 피드백이 들어옵니다. 사람 인수인계 방식은 매 단계마다 쌓이고, 병렬로 실행되는 코딩 에이전트는 들어오는 속도만큼 빠르게 큐를 비워냅니다.',
    pipelineLabelBefore: '이전',
    pipelineLabelAfter: 'RUNHQ와 함께',
    // Loop section
    loopH2Line1: '모든 릴리스는 같은',
    loopH2Line2: '루프를 따라갑니다.',
    loopDeck: '대부분의 코딩 에이전트 스택은 “에이전트 완료”에서 멈춥니다. 그건 중간 단계일 뿐입니다. RunHQ는 양쪽 끝 — 앞에서의 수집과 뒤에서의 리뷰 — 을 책임지기 때문에, 중간은 누구도 불안하지 않게 무인으로 돌아갈 수 있습니다.',
    // Loop stage 01 — Collect feedback
    loop1Title: '피드백 수집',
    loop1Sub: '위젯 하나, 추가 로그인 없음.',
    loop1Body: '사용자와 동료가 임베디드 위젯을 통해 제품에서 바로 피드백을 보냅니다 — 별도의 계정도, 로그인 장벽도 없습니다. 모든 리포트는 페이지, 사용자, 재현 컨텍스트가 함께 RunHQ로 도착합니다.',
    loop1Key1: '임베디드 위젯',
    loop1Key2: '로그인 장벽 없음',
    loop1Key3: '자동 컨텍스트',
    // Loop stage 02 — Assign coding agents
    loop2Title: '코딩 에이전트 할당',
    loop2Sub: '병렬로 실행하세요.',
    loop2Body: 'Claude Code, Cursor, Codex, 또는 직접 만든 커스텀 에이전트에 작업을 할당하세요. RunHQ는 프로세스를 병렬로 띄우면서 중요한 세부 사항을 모두 기록해 완전한 투명성을 제공합니다.',
    loop2Key1: '내 에이전트 연결',
    loop2Key2: '병렬 실행',
    loop2Key3: '전체 감사 로그',
    // Loop stage 03 — Review code
    loop3Title: '코드 리뷰',
    loop3Sub: 'PR이 바로 읽을 준비된 채로 도착합니다.',
    loop3Body: '모든 에이전트 실행은 diff, 요약, 출처가 첨부된 깔끔한 풀 리퀘스트로 도착합니다 — 리뷰어는 이미 쓰던 GitHub 플로우 안에서 훑고, 코멘트하고, 승인하면 됩니다.',
    loop3Key1: 'GitHub PR',
    loop3Key2: '인라인 diff',
    loop3Key3: '원클릭 되돌리기',
    // Loop stage 04 — Test + Deploy
    loop4Title: '테스트 + 배포',
    loop4Sub: '배포 전에 앱을 직접 돌려보세요.',
    loop4Body: 'RunHQ는 모든 PR에 대해 자체 URL과 자체 환경을 갖춘 완전한 서버를 띄워줍니다 — 그래서 이미 사용 중인 배포 파이프라인에 머지되기 전에 변경 사항을 엔드 투 엔드로 실제로 돌려볼 수 있습니다.',
    loop4Key1: '라이브 프리뷰 환경',
    loop4Key2: 'PR별 샌드박스',
    loop4Key3: '기존 CD로 배포',
    // LoopCapture demo rows
    captureWho1: 'Jen K.',
    captureTxt1: 'Safari에서 Stripe 포털 세션이 끊김',
    captureWho2: 'Tomas R.',
    captureTxt2: '프로젝트 테이블에서 일괄 아카이브',
    captureWho3: 'Andre B.',
    captureTxt3: '콜드 스타트 시 문서 페이지가 504 반환',
    // LoopAssign demo rows
    assignTask1: 'Stripe 포털 리다이렉트',
    assignTask2: '프로젝트 일괄 아카이브',
    assignTask3: '콜드 스타트 시 문서 페이지 504',
    assignStatusRunning: '실행 중',
    assignStatusQueued: '대기 중',
    assignStatusStandby: '대기',
    assignLabel: '할당 대상',
    // LoopReview demo
    reviewPrH: 'PR #4821 · portal: cross-site cookies',
    reviewPrMeta: '+8 −3 · 파일 1개 변경 · 리뷰 준비됨',
    reviewBtnApprove: '승인',
    reviewBtnRequest: '수정 요청',
    reviewBtnRevert: '되돌리기',
    // LoopDeploy demo
    deployPreviewLabel: '프리뷰:',
    deployPreviewV: 'pr-4821.runhq.dev · 준비됨',
    deployTestsLabel: '테스트:',
    deployTestsV: '23개 통과 · 142s',
    deployDeployLabel: '배포:',
    deployDeployV: 'vercel · production',
    deployLiveLabel: '라이브:',
    deployLiveV: 'portal.runhq.io · 200 OK',
    // CTA band
    ctaH1: '피드백을 손으로 옮기는 건 그만.',
    ctaH2: '바로 배포하세요.',
    ctaBtnPrimary: '무료로 시작하기 →',
    ctaBtnSecondary: '20분 데모 예약하기',
    ctaMeta1Strong: '60분 안에 라이브.',
    ctaMeta1: '위젯을 붙이고, 소스를 연결하고, 점심 전에 배포하세요.',
    ctaMeta2Strong: '감사 로그 내보내기.',
    ctaMeta2: '수집 단계에서 PII 제거. 모든 에이전트 액션 버전 관리.',
    ctaMeta3Strong: '언제든 해지.',
    ctaMeta3: '나갈 때 감사 로그를 그대로 가져가세요.',
    // Modal
    modalAriaLabel: '데모 영상',
    modalCloseLabel: '데모 영상 닫기',
  },
} as const;

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
  const lp = useLocalePath();
  // lp is wired up for any future internal links; current CTAs use external auth URLs.
  void lp;
  const [demoOpen, setDemoOpen] = useState(false);
  const demoBtnRef = useRef<HTMLButtonElement>(null);
  const [pipelineResetTick, setPipelineResetTick] = useState(0);

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
        <div className="rhw-hero-side">
          <h1 className="rhw-hero-h1">
            {t.heroH1Line1} {t.heroH1Line2}
          </h1>
          <p className="rhw-hero-lede">
            {t.heroLede}
          </p>
          <div className="rhw-hero-cta">
            <a className="rhw-btn-primary" href={SIGNUP_URL}>{t.ctaStartFree} <span>→</span></a>
            <button
              ref={demoBtnRef}
              type="button"
              className="rhw-btn-ghost"
              onClick={() => setDemoOpen(true)}
            >
              <span className="rhw-play">▶</span>
              {t.ctaWatchDemo}
            </button>
          </div>

        </div>

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

      {/* CTA */}
      <section className="rhw-cta-band">
        <div className="rhw-cta-inner">
          <h2 className="rhw-cta-h">
            {t.ctaH1}<br />
            {t.ctaH2}
          </h2>
          <div className="rhw-cta-actions">
            <a className="rhw-btn-primary rhw-btn-lg" href={SIGNUP_URL}>{t.ctaBtnPrimary}</a>
            <a className="rhw-btn-ghost rhw-btn-lg" href={LOGIN_URL}>{t.ctaBtnSecondary}</a>
          </div>
          <div className="rhw-cta-meta">
            <div><strong>{t.ctaMeta1Strong}</strong> {t.ctaMeta1}</div>
            <div><strong>{t.ctaMeta2Strong}</strong> {t.ctaMeta2}</div>
            <div><strong>{t.ctaMeta3Strong}</strong> {t.ctaMeta3}</div>
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
