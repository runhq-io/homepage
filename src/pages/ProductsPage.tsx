import { Link } from 'react-router-dom';
import { Navbar, Footer, Avatar } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { useT, useLocalePath } from '../i18n/context';

const PRODUCTS_T = {
  en: {
    heroEyebrow: 'Products · The closed loop',
    heroH1: 'One platform. Four surfaces. The whole loop.',
    heroLede:
      'RunHQ captures the moment someone tells you something is broken, hands it to the right agent in a reproducible workspace, then routes the diff back to a reviewer. Four products. One queue. One audit log.',
    startFree: 'Talk to us →',
    seePricing: 'See pricing',

    // Product visuals — status labels (Projects mock)
    pvProjStatusShipping: 'shipping',
    pvProjStatusMerged: 'merged',
    pvProjStatusPlanned: 'planned',
    pvProjRow1: 'Bulk archive in projects table',
    pvProjRow2: 'Stripe portal redirect',
    pvProjRow3: 'Dark mode for public boards',

    // Widget visual
    pvWidgetMsg: 'Stripe portal redirect drops my session in Safari…',
    pvWidgetSub: '/billing · Safari 17.4 · 1 console err',
    pvWidgetTag: '↓ auto-attached',
    pvWidgetTrace: 'Set-Cookie blocked: SameSite=Lax',

    // Dev visual
    pvDevTests: '23 passed',
    pvDevFootPrefix: 'tests: ',
    pvDevFootSuffix: ' · diff +8 −3',

    // Products
    p1Name: 'Agent automation',
    p1Pitch:
      'Capture user feedback, package the run-context, and dispatch to Claude Code, Cursor, Codex, or Devin — never lose a screenshot, repro, or stack trace again.',
    p1Blurb: 'The orchestration layer.',
    p1H1: 'Multi-agent dispatch with policy guardrails',
    p1H2: 'Context bundles: repro, logs, screenshots, prior runs',
    p1H3: 'Two-way sync with Linear, GitHub, Slack, Intercom',
    p1H4: 'Audit-grade provenance on every diff',

    p2Name: 'Project management',
    p2Pitch:
      'Tickets that know who their agent is, what context they ran with, and which diff they produced. The whole loop, one queue, no swivel-chair.',
    p2Blurb: 'Where the work lives.',
    p2H1: 'Provenance from feedback → ticket → run → diff',
    p2H2: 'Reviewer routing with codeowner-aware rules',
    p2H3: 'Bidirectional sync with Linear and GitHub Issues',
    p2H4: 'Per-project policies and rate caps',

    p3Name: 'Dev environment',
    p3Pitch:
      'Spin up isolated, deterministic dev sandboxes in seconds — pre-warmed, scoped credentials, every run logged. The cleanroom your agents needed.',
    p3Blurb: 'Where the agents work.',
    p3H1: 'Deterministic Nix-based environments',
    p3H2: 'Per-run secrets with scoped lifetimes',
    p3H3: 'Streaming logs piped into the audit log',
    p3H4: 'BYO model + private runners on Business+',

    p4Name: 'Feedback widget',
    p4Pitch:
      'A few lines of script, every browser. Captures DOM state, console, network, video, and user identity — and routes it straight into the queue.',
    p4Blurb: 'Where the loop starts.',
    p4H1: 'Auto-captures DOM, console, network, session video',
    p4H2: 'PII-aware redaction with per-field controls',
    p4H3: 'Identity via Clerk, Auth0, Supabase, custom JWT',
    p4H4: 'Style-matches your brand in 30 seconds',

    // Loop steps
    loopEyebrow: 'How it fits together',
    loopTitle: 'The closed loop.',
    loopSub:
      'The four products are designed as one surface. Feedback enters at the widget, leaves at a merged PR — and every step in between is observable.',

    step1Label: 'Capture',
    step1Source: 'Feedback widget',
    step1Desc:
      'A real user hits a snag. The widget bundles repro, console, network, video — and a ticket is born.',
    step2Label: 'Route',
    step2Source: 'Project management',
    step2Desc:
      'Tickets land in the queue with provenance, codeowner routing, and policy applied — ready for an agent.',
    step3Label: 'Run',
    step3Source: 'Agent automation · Dev environment',
    step3Desc:
      'Claude, Cursor, Codex, or Devin picks up the ticket inside a deterministic sandbox. Every keystroke logged.',
    step4Label: 'Review',
    step4Source: 'Project management',
    step4Desc:
      'Diff lands back in the queue with run logs and provenance attached. A human merges, or sends it back.',

    // Closing CTA
    ctaH: 'Run the whole loop on one queue.',
    ctaSub: 'Free for solo projects. 14-day Team trial. No card.',
  },
  ko: {
    heroEyebrow: '제품 · 닫힌 루프',
    heroH1: '하나의 플랫폼. 네 개의 표면. 전체 루프.',
    heroLede:
      'RunHQ는 누군가 "이거 안 돼요"라고 말하는 순간을 포착해, 재현 가능한 워크스페이스에서 알맞은 에이전트에게 넘기고, 그 결과 diff를 다시 리뷰어에게 라우팅합니다. 제품 네 개. 큐 하나. 감사 로그 하나.',
    startFree: '문의하기 →',
    seePricing: '가격 보기',

    // Product visuals — status labels (Projects mock)
    pvProjStatusShipping: '배포 중',
    pvProjStatusMerged: '병합됨',
    pvProjStatusPlanned: '예정',
    pvProjRow1: '프로젝트 테이블 일괄 보관',
    pvProjRow2: 'Stripe 포털 리다이렉트',
    pvProjRow3: '공개 보드 다크 모드',

    // Widget visual
    pvWidgetMsg: 'Safari에서 Stripe 포털로 리다이렉트되면 세션이 끊겨요…',
    pvWidgetSub: '/billing · Safari 17.4 · 콘솔 에러 1건',
    pvWidgetTag: '↓ 자동 첨부됨',
    pvWidgetTrace: 'Set-Cookie blocked: SameSite=Lax',

    // Dev visual
    pvDevTests: '23개 통과',
    pvDevFootPrefix: '테스트: ',
    pvDevFootSuffix: ' · diff +8 −3',

    // Products
    p1Name: '에이전트 자동화',
    p1Pitch:
      '사용자 피드백을 받아 실행 컨텍스트로 패키징하고, Claude Code, Cursor, Codex, Devin에 디스패치합니다. 스크린샷, 재현 절차, 스택 트레이스를 다시는 잃지 마세요.',
    p1Blurb: '에이전트 지휘 레이어.',
    p1H1: '정책 가드레일이 적용된 멀티 에이전트 디스패치',
    p1H2: '컨텍스트 번들: 재현 절차, 로그, 스크린샷, 이전 실행 기록',
    p1H3: 'Linear, GitHub, Slack, Intercom과 양방향 동기화',
    p1H4: '모든 diff에 감사 등급 출처(provenance)',

    p2Name: '프로젝트 관리',
    p2Pitch:
      '어떤 에이전트가 어떤 컨텍스트로 실행해 어떤 diff를 만들었는지 아는 티켓. 전체 루프, 하나의 큐, 화면 전환 없음.',
    p2Blurb: '일이 머무는 곳.',
    p2H1: '피드백 → 티켓 → 실행 → diff까지 이어지는 출처(provenance)',
    p2H2: '코드오너 인식 규칙 기반 리뷰어 라우팅',
    p2H3: 'Linear, GitHub Issues와 양방향 동기화',
    p2H4: '프로젝트별 정책과 레이트 캡',

    p3Name: '개발 환경',
    p3Pitch:
      '격리되고 결정적인 개발 샌드박스를 수 초 만에 띄웁니다. 예열된 환경, 범위가 제한된 자격 증명, 모든 실행 로그 기록. 에이전트에게 필요했던 클린룸입니다.',
    p3Blurb: '에이전트가 일하는 곳.',
    p3H1: 'Nix 기반 결정적 환경',
    p3H2: '범위가 제한된 수명의 실행별 시크릿',
    p3H3: '감사 로그로 흘러가는 스트리밍 로그',
    p3H4: 'Business+ 플랜에서 BYO 모델 + 프라이빗 러너',

    p4Name: '피드백 위젯',
    p4Pitch:
      '몇 줄의 스크립트, 모든 브라우저. DOM 상태, 콘솔, 네트워크, 비디오, 사용자 식별 정보를 캡처해 곧장 큐로 보냅니다.',
    p4Blurb: '루프가 시작되는 곳.',
    p4H1: 'DOM, 콘솔, 네트워크, 세션 비디오 자동 캡처',
    p4H2: '개인정보 인식 마스킹, 필드 단위 제어',
    p4H3: 'Clerk, Auth0, Supabase, 커스텀 JWT 기반 신원',
    p4H4: '30초 만에 브랜드에 맞춘 스타일링',

    // Loop steps
    loopEyebrow: '어떻게 맞물리는가',
    loopTitle: '닫힌 루프.',
    loopSub:
      '네 제품은 하나의 표면으로 설계되었습니다. 피드백은 위젯에서 들어와 병합된 PR에서 나갑니다. 그 사이 모든 단계가 관측 가능합니다.',

    step1Label: '캡처',
    step1Source: '피드백 위젯',
    step1Desc:
      '실제 사용자가 문제에 부딪힙니다. 위젯이 재현 절차, 콘솔, 네트워크, 비디오를 번들로 묶고 티켓이 생성됩니다.',
    step2Label: '라우팅',
    step2Source: '프로젝트 관리',
    step2Desc:
      '티켓이 출처, 코드오너 라우팅, 정책이 적용된 채로 큐에 도착해 에이전트를 기다립니다.',
    step3Label: '실행',
    step3Source: '에이전트 자동화 · 개발 환경',
    step3Desc:
      'Claude, Cursor, Codex 또는 Devin이 결정적 샌드박스 안에서 티켓을 집어 듭니다. 모든 키 입력이 기록됩니다.',
    step4Label: '리뷰',
    step4Source: '프로젝트 관리',
    step4Desc:
      '실행 로그와 출처가 첨부된 채로 diff가 큐로 돌아옵니다. 사람이 병합하거나 다시 돌려보냅니다.',

    // Closing CTA
    ctaH: '전체 루프를 하나의 큐에서.',
    ctaSub: '솔로 프로젝트는 무료. 팀 플랜 14일 체험. 카드 없이.',
  },
} as const;

const PV_Auto = () => (
  <div className="rhw-pv-auto">
    <div className="rhw-pv-auto-line"><span className="rhw-pv-key">workflow</span> daily-triage</div>
    <div className="rhw-pv-auto-line rhw-pv-indent"><span className="rhw-pv-prop">on:</span> 09:00 UTC + widget:new</div>
    <div className="rhw-pv-auto-line rhw-pv-indent"><span className="rhw-pv-prop">group:</span> by-component</div>
    <div className="rhw-pv-auto-line rhw-pv-indent"><span className="rhw-pv-prop">route:</span> sev:P1 → claude</div>
    <div className="rhw-pv-auto-line rhw-pv-indent"><span className="rhw-pv-prop">review:</span> #eng-prs</div>
  </div>
);

const PV_Projects = ({ rows }: { rows: Array<{ v: number; t: string; s: string; label: string }> }) => (
  <div className="rhw-pv-proj">
    {rows.map((r, i) => (
      <div key={i} className="rhw-pv-proj-row">
        <span className="rhw-pv-vote">▲ {r.v}</span>
        <span className="rhw-pv-proj-t">{r.t}</span>
        <span className={`rhw-pv-proj-s rhw-pv-proj-s-${r.s}`}>{r.label}</span>
      </div>
    ))}
  </div>
);

const PV_Dev = ({ testsPassed, footPrefix, footSuffix }: { testsPassed: string; footPrefix: string; footSuffix: string }) => (
  <div className="rhw-pv-dev">
    <div className="rhw-pv-dev-row"><span className="rhw-pv-add">+</span> ./auth/portal.tsx</div>
    <div className="rhw-pv-dev-row rhw-pv-indent"><span className="rhw-pv-rem">−</span> withCredentials: false</div>
    <div className="rhw-pv-dev-row rhw-pv-indent"><span className="rhw-pv-add">+</span> withCredentials: true</div>
    <div className="rhw-pv-dev-foot">{footPrefix}<strong>{testsPassed}</strong>{footSuffix}</div>
  </div>
);

const PV_Widget = ({ msg, sub, tag, trace }: { msg: string; sub: string; tag: string; trace: string }) => (
  <div className="rhw-pv-widget">
    <div className="rhw-pv-widget-msg">
      <Avatar name="Jen K." size={20} />
      <div>
        <div>{msg}</div>
        <div className="rhw-pv-widget-sub">{sub}</div>
      </div>
    </div>
    <div className="rhw-pv-widget-tag">{tag}</div>
    <div className="rhw-pv-widget-trace">{trace}</div>
  </div>
);

type Product = {
  key: string;
  n: string;
  tag: string;
  name: string;
  pitch: string;
  blurb: string;
  highlights: string[];
  Visual: () => JSX.Element;
};

export default function ProductsPage() {
  const t = useT(PRODUCTS_T);
  const lp = useLocalePath();

  const projRows = [
    { v: 47, t: t.pvProjRow1, s: 'shipping', label: t.pvProjStatusShipping },
    { v: 23, t: t.pvProjRow2, s: 'merged', label: t.pvProjStatusMerged },
    { v: 18, t: t.pvProjRow3, s: 'planned', label: t.pvProjStatusPlanned },
  ];

  const PRODUCTS: Product[] = [
    {
      key: 'agent',
      n: '01',
      tag: '/auto',
      name: t.p1Name,
      pitch: t.p1Pitch,
      blurb: t.p1Blurb,
      highlights: [t.p1H1, t.p1H2, t.p1H3, t.p1H4],
      Visual: PV_Auto,
    },
    {
      key: 'projects',
      n: '02',
      tag: '/projects',
      name: t.p2Name,
      pitch: t.p2Pitch,
      blurb: t.p2Blurb,
      highlights: [t.p2H1, t.p2H2, t.p2H3, t.p2H4],
      Visual: () => <PV_Projects rows={projRows} />,
    },
    {
      key: 'runhq',
      n: '03',
      tag: '/dev',
      name: t.p3Name,
      pitch: t.p3Pitch,
      blurb: t.p3Blurb,
      highlights: [t.p3H1, t.p3H2, t.p3H3, t.p3H4],
      Visual: () => (
        <PV_Dev
          testsPassed={t.pvDevTests}
          footPrefix={t.pvDevFootPrefix}
          footSuffix={t.pvDevFootSuffix}
        />
      ),
    },
    {
      key: 'widget',
      n: '04',
      tag: '/widget',
      name: t.p4Name,
      pitch: t.p4Pitch,
      blurb: t.p4Blurb,
      highlights: [t.p4H1, t.p4H2, t.p4H3, t.p4H4],
      Visual: () => (
        <PV_Widget
          msg={t.pvWidgetMsg}
          sub={t.pvWidgetSub}
          tag={t.pvWidgetTag}
          trace={t.pvWidgetTrace}
        />
      ),
    },
  ];

  const LOOP_STEPS = [
    { i: '01', label: t.step1Label, source: t.step1Source, desc: t.step1Desc },
    { i: '02', label: t.step2Label, source: t.step2Source, desc: t.step2Desc },
    { i: '03', label: t.step3Label, source: t.step3Source, desc: t.step3Desc },
    { i: '04', label: t.step4Label, source: t.step4Source, desc: t.step4Desc },
  ];

  return (
    <div className="rhp-root rhpp-root">
      <style>{PRODUCTS_STYLES}</style>
      <Navbar active="products" />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">{t.heroEyebrow}</div>
        <h1 className="rhp-hero-h1">{t.heroH1}</h1>
        <p className="rhp-hero-lede">
          {t.heroLede}
        </p>
        <div className="rhpp-hero-cta">
          <TalkToUsButton className="rhp-btn-primary">{t.startFree}</TalkToUsButton>
          <Link className="rhp-btn-ghost" to={lp('/pricing')}>{t.seePricing}</Link>
        </div>
      </section>

      <section className="rhpp-grid">
        {PRODUCTS.map((p) => (
          <article key={p.key} className="rhpp-card">
            <div className="rhpp-card-top">
              <span className="rhpp-card-tag">{p.tag}</span>
              <span className="rhpp-card-num">{p.n} / 04</span>
            </div>
            <div className="rhpp-card-visual"><p.Visual /></div>
            <h3 className="rhpp-card-name">{p.name}</h3>
            <p className="rhpp-card-pitch">{p.pitch}</p>
            <ul className="rhpp-card-feats">
              {p.highlights.map((h) => (
                <li key={h}>
                  <span className="rhpp-card-tick">✓</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
            <div className="rhpp-card-foot">
              <span className="rhpp-card-blurb">{p.blurb}</span>
            </div>
          </article>
        ))}
      </section>

      <section className="rhpp-loop">
        <div className="rhpp-loop-h">
          <div className="rhpp-loop-eyebrow">{t.loopEyebrow}</div>
          <h2 className="rhpp-loop-title">{t.loopTitle}</h2>
          <p className="rhpp-loop-sub">
            {t.loopSub}
          </p>
        </div>
        <ol className="rhpp-loop-list">
          {LOOP_STEPS.map((s) => (
            <li key={s.i} className="rhpp-loop-step">
              <span className="rhpp-loop-num">{s.i}</span>
              <div>
                <div className="rhpp-loop-row">
                  <span className="rhpp-loop-label">{s.label}</span>
                  <span className="rhpp-loop-source">{s.source}</span>
                </div>
                <p className="rhpp-loop-desc">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rhpp-cta">
        <h2 className="rhpp-cta-h">{t.ctaH}</h2>
        <p className="rhpp-cta-sub">{t.ctaSub}</p>
        <div className="rhpp-cta-row">
          <TalkToUsButton className="rhp-btn-primary">{t.startFree}</TalkToUsButton>
          <Link className="rhp-btn-ghost" to={lp('/pricing')}>{t.seePricing}</Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}

const PRODUCTS_STYLES = `
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
    max-width: 700px;
    margin: 0 auto;
    text-wrap: pretty;
  }
  .rhpp-hero-cta {
    display: flex; gap: 10px; justify-content: center;
    margin-top: 32px;
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

  .rhpp-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    padding: 40px 48px 28px;
    max-width: 1200px; margin: 0 auto;
  }
  .rhpp-card {
    position: relative;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 18px;
    padding: 28px 28px 24px;
    display: flex; flex-direction: column;
  }
  .rhpp-card-top {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 18px;
  }
  .rhpp-card-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    padding: 3px 9px;
    background: var(--rhw-bg-2);
    border-radius: 999px;
    color: var(--rhw-ink-soft);
  }
  .rhpp-card-num {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--rhw-ink-faint);
  }
  .rhpp-card-visual {
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 12px;
    padding: 20px;
    height: 200px;
    margin-bottom: 22px;
    overflow: hidden;
    position: relative;
  }
  .rhpp-card-name {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.2;
    margin: 0 0 10px;
    text-wrap: balance;
  }
  .rhpp-card-pitch {
    font-size: 14.5px;
    color: var(--rhw-ink-soft);
    margin: 0 0 18px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .rhpp-card-feats {
    list-style: none;
    margin: 0 0 22px;
    padding: 14px 0 0;
    border-top: 1px solid var(--rhw-line-soft);
    display: grid;
    gap: 7px;
  }
  .rhpp-card-feats li {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 9px;
    font-size: 13.5px;
    color: var(--rhw-ink-soft);
    align-items: start;
  }
  .rhpp-card-tick {
    font-size: 13px;
    line-height: 1.55;
    font-weight: 600;
    color: var(--rhw-accent);
  }
  .rhpp-card-foot {
    margin-top: auto;
    padding-top: 18px;
    border-top: 1px dashed var(--rhw-line);
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
  }
  .rhpp-card-blurb {
    font-size: 12.5px;
    color: var(--rhw-ink-mute);
    font-style: italic;
  }

  /* Product visuals (mockups inside .rhpp-card-visual) */
  .rhw-pv-auto { font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.85; color: var(--rhw-ink); }
  .rhw-pv-key { color: var(--rhw-accent); font-weight: 500; }
  .rhw-pv-prop { color: var(--rhw-ink-mute); }
  .rhw-pv-indent { padding-left: 18px; }

  .rhw-pv-proj { display: flex; flex-direction: column; gap: 8px; }
  .rhw-pv-proj-row {
    display: grid; grid-template-columns: 50px 1fr auto;
    gap: 10px; align-items: center;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 8px;
    padding: 8px 12px;
  }
  .rhw-pv-vote { color: var(--rhw-accent); font-size: 11px; font-weight: 500; }
  .rhw-pv-proj-t { font-size: 12.5px; }
  .rhw-pv-proj-s { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; }
  .rhw-pv-proj-s-shipping { background: oklch(0.78 0.18 290 / 0.18); color: oklch(0.42 0.20 290); }
  .rhw-pv-proj-s-merged { background: oklch(0.85 0.16 145 / 0.22); color: oklch(0.38 0.16 145); }
  .rhw-pv-proj-s-planned { background: var(--rhw-bg-2); color: var(--rhw-ink-mute); }

  .rhw-pv-dev { font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.7; }
  .rhw-pv-dev-row { color: var(--rhw-ink); }
  .rhw-pv-add { color: var(--rhw-good); font-weight: 700; }
  .rhw-pv-rem { color: var(--rhw-bad); font-weight: 700; }
  .rhw-pv-dev-foot { color: var(--rhw-ink-mute); margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--rhw-line-soft); font-size: 11px; }
  .rhw-pv-dev-foot strong { color: var(--rhw-good); font-weight: 500; }

  .rhw-pv-widget { display: flex; flex-direction: column; }
  .rhw-pv-widget-msg {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line-soft);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex; gap: 10px; align-items: flex-start;
    font-size: 12.5px; color: var(--rhw-ink);
    line-height: 1.4;
  }
  .rhw-pv-widget-sub { font-size: 10.5px; color: var(--rhw-ink-mute); margin-top: 4px; font-family: 'JetBrains Mono', monospace; }
  .rhw-pv-widget-tag { font-size: 10.5px; color: var(--rhw-accent); margin: 8px 4px; letter-spacing: 0.04em; }
  .rhw-pv-widget-trace {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    background: var(--rhw-ink);
    color: #f3c98a;
    padding: 8px 12px;
    border-radius: 6px;
  }

  .rhpp-loop {
    max-width: 1200px;
    margin: 0 auto;
    padding: 56px 48px;
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 56px;
    align-items: start;
  }
  .rhpp-loop-eyebrow {
    font-size: 11.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 14px;
  }
  .rhpp-loop-title {
    font-size: 38px;
    font-weight: 600;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 14px;
    text-wrap: balance;
  }
  .rhpp-loop-sub {
    font-size: 15.5px;
    color: var(--rhw-ink-soft);
    line-height: 1.6;
    text-wrap: pretty;
    margin: 0;
  }
  .rhpp-loop-list {
    list-style: none;
    margin: 0; padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rhpp-loop-step {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 18px;
    padding: 18px 0;
    border-bottom: 1px solid var(--rhw-line-soft);
  }
  .rhpp-loop-step:last-child { border-bottom: 0; }
  .rhpp-loop-num {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px;
    color: var(--rhw-ink-mute);
    letter-spacing: 0.06em;
    padding-top: 3px;
  }
  .rhpp-loop-row {
    display: flex; align-items: baseline; gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .rhpp-loop-label {
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.018em;
    color: var(--rhw-ink);
  }
  .rhpp-loop-source {
    font-size: 11.5px;
    color: var(--rhw-ink-mute);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .rhpp-loop-desc {
    font-size: 14px;
    color: var(--rhw-ink-soft);
    line-height: 1.55;
    margin: 0;
    text-wrap: pretty;
  }

  .rhpp-cta {
    text-align: center;
    padding: 56px 48px 96px;
    max-width: 880px;
    margin: 0 auto;
  }
  .rhpp-cta-h {
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 12px;
    text-wrap: balance;
  }
  .rhpp-cta-sub {
    font-size: 14.5px;
    color: var(--rhw-ink-mute);
    margin: 0 0 24px;
  }
  .rhpp-cta-row {
    display: flex; gap: 10px; justify-content: center;
  }

  @media (max-width: 920px) {
    .rhpp-grid { grid-template-columns: 1fr; padding: 28px 24px 20px; }
    .rhpp-loop { grid-template-columns: 1fr; gap: 28px; padding: 40px 24px; }
    .rhpp-loop-title { font-size: 30px; }
    .rhp-hero { padding: 56px 24px 24px; }
    .rhp-hero-h1 { font-size: 36px; }
    .rhp-hero-lede { font-size: 16px; }
    .rhpp-cta { padding: 40px 24px 64px; }
    .rhpp-cta-h { font-size: 26px; }
  }
`;
