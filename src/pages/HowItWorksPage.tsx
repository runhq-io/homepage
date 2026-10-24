import { Link } from 'react-router-dom';
import { HomeNav, HomeFooter, HOME_CHROME_STYLES, SHOWCASE_BOARD_URL } from '../components/homeChrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { useT, useLocalePath } from '../i18n/context';

/**
 * /how-it-works: the RunHQ loop in three stages. Build (ticket to deploy), Run
 * (the live-product tools that hand work back to the agents) and Evolve
 * (variations measured against a goal), then where people step in.
 *
 * Copy is drawn from the site's existing product copy. Same rules as the
 * homepage: no em dashes, the product is live, and only claims true today.
 */
const HIW_T = {
  en: {
    eyebrow: 'How it works',
    h1A: 'One loop that builds, runs and ',
    h1B: 'evolves your product.',
    lede: 'RunHQ is one workspace where AI agents build your product, run it after launch and keep improving it. You decide what matters and approve what ships.',

    loop: [
      { k: 'Build', b: 'Agents turn tickets into shipped changes.' },
      { k: 'Run', b: 'The live product turns what users hit into tickets.' },
      { k: 'Evolve', b: 'Variations are measured and the best survive.' },
    ],

    stages: [
      {
        k: 'Build',
        h: 'From ticket to production',
        deck: 'Every change follows the same path. You step in only where judgment matters.',
        rows: [
          { t: 'Write a ticket', b: 'Type it, dictate it, or let it arrive from the widget, the error tracker or a failed deploy. Attach screenshots and logs; agents use them.' },
          { t: 'An agent takes it', b: 'Claude Code or Codex works it in its own worktree, branch and terminal. Run as many in parallel as you like.' },
          { t: 'Try it before it merges', b: 'Every worktree has its own preview of your app, so you click through the change instead of imagining it from a diff.' },
          { t: 'Audit and review', b: 'The pull request is audited automatically and findings go back to the agent that wrote it. You review the diff when it is clean.' },
          { t: 'Merge and deploy', b: 'Merge with one shortcut. Each deploy shows which tickets it carries, and a failed deploy offers a ticket to fix itself.' },
        ],
      },
      {
        k: 'Run',
        h: 'After it ships, it keeps listening',
        deck: 'The tools that run a live product sit next to the agents, so whatever users run into becomes work without being copied anywhere.',
        rows: [
          { t: 'CRM and inbox', b: 'Email, SMS, WhatsApp, calls and a help centre on one timeline per person. A support agent answers from your knowledge base.', f: 'Requests worth building' },
          { t: 'Widget', b: 'A chat and feedback board inside your app. Users report, vote and follow along without an account.', f: 'Bug reports with the page and user attached' },
          { t: 'Errors', b: 'Errors from your app and server, grouped by cause.', f: 'A fix ticket in one click, with an agent on it' },
          { t: 'Analytics', b: 'Funnels for what first-time users actually do.', f: 'The step where people drop off' },
        ],
      },
      {
        k: 'Evolve',
        beta: true,
        h: 'Evolution, automated',
        deck: 'Instead of guessing which version is best, RunHQ tries several and keeps what works.',
        rows: [
          { t: 'Set a goal', b: 'Pick the number that matters, like checkout conversion, measured in Mixpanel, PostHog or your own data.' },
          { t: 'Build variations', b: 'Agents build them as ordinary jobs, through the same preview, audit and review.' },
          { t: 'Measure', b: 'Evolve tracks which variations are live and assesses each one against the goal.' },
          { t: 'Keep the best', b: 'Losers are pruned. Winners seed the jobs that build the next generation.' },
        ],
      },
    ],
    beta: 'beta',
    handsOff: 'Hands the agents',

    youH: 'Where you come in',
    you: [
      { t: 'What to build', b: 'Write and prioritise tickets, or set a goal for Evolve.' },
      { t: 'Whether it is right', b: 'Try the preview, read the diff, approve or send it back.' },
      { t: 'When it ships', b: 'Merge and deploy.' },
    ],
    youNote: 'Everything else, the agents handle.',

    ctaH: 'See it on a real project.',
    ctaDeck: 'Every RunHQ project can have a public board with its real tickets, agent work and deploys.',
    ctaBoard: 'Open a live board ↗',
    ctaTalk: 'Contact sales',
    ctaDocs: 'Read the docs',
  },
  ko: {
    eyebrow: '작동 방식',
    h1A: '제품을 만들고, 운영하고, ',
    h1B: '진화시키는 하나의 루프.',
    lede: 'RunHQ는 AI 에이전트가 제품을 만들고, 출시 후 운영하고, 계속 개선하는 하나의 워크스페이스입니다. 무엇이 중요한지 정하고 무엇을 배포할지 승인하는 건 당신입니다.',

    loop: [
      { k: '만들기', b: '에이전트가 티켓을 배포된 변경으로 바꿉니다.' },
      { k: '운영', b: '라이브 제품이 사용자가 겪은 일을 티켓으로 바꿉니다.' },
      { k: '진화', b: '변형을 측정하고 가장 좋은 것만 남깁니다.' },
    ],

    stages: [
      {
        k: '만들기',
        h: '티켓에서 프로덕션까지',
        deck: '모든 변경은 같은 길을 갑니다. 당신은 판단이 필요한 곳에만 개입하면 됩니다.',
        rows: [
          { t: '티켓 작성', b: '직접 쓰거나, 받아쓰거나, 위젯, 에러 추적, 실패한 배포에서 들어오게 하세요. 스크린샷과 로그를 붙이면 에이전트가 활용합니다.' },
          { t: '에이전트가 맡음', b: 'Claude Code나 Codex가 자체 워크트리, 브랜치, 터미널에서 작업합니다. 원하는 만큼 병렬로 돌리세요.' },
          { t: '머지 전에 직접 써 보기', b: '워크트리마다 앱 프리뷰가 있어서, diff로 상상하는 대신 변경 사항을 직접 클릭해 볼 수 있습니다.' },
          { t: '감사와 리뷰', b: '풀 리퀘스트는 자동으로 감사되고, 지적 사항은 작성한 에이전트에게 돌아갑니다. 깔끔해지면 diff를 리뷰하세요.' },
          { t: '머지와 배포', b: '단축키 하나로 머지하세요. 배포마다 어떤 티켓이 실렸는지 보이고, 실패한 배포는 스스로 고칠 티켓을 제안합니다.' },
        ],
      },
      {
        k: '운영',
        h: '배포 후에도 계속 듣습니다',
        deck: '라이브 제품을 운영하는 도구가 에이전트 바로 옆에 있어서, 사용자가 겪은 일이 어디에도 옮겨 적지 않고 바로 작업이 됩니다.',
        rows: [
          { t: 'CRM과 인박스', b: '이메일, SMS, WhatsApp, 전화, 헬프 센터를 사람별 타임라인 하나로. 지원 에이전트가 지식 베이스로 답합니다.', f: '만들 가치가 있는 요청' },
          { t: '위젯', b: '앱 안의 채팅과 피드백 보드. 사용자는 계정 없이 신고하고, 투표하고, 진행 상황을 지켜봅니다.', f: '페이지와 사용자 정보가 붙은 버그 리포트' },
          { t: '에러', b: '앱과 서버의 에러를 원인별로 묶어 보여줍니다.', f: '클릭 한 번으로 수정 티켓과 담당 에이전트' },
          { t: '애널리틱스', b: '처음 온 사용자가 실제로 무엇을 하는지 보여주는 퍼널.', f: '사람들이 떠나는 단계' },
        ],
      },
      {
        k: '진화',
        beta: true,
        h: '진화, 자동으로',
        deck: '어떤 버전이 가장 좋을지 추측하는 대신, RunHQ가 여러 버전을 시도하고 효과 있는 것을 남깁니다.',
        rows: [
          { t: '목표 정하기', b: '결제 전환율처럼 중요한 숫자를 고르세요. Mixpanel, PostHog, 또는 자체 데이터로 측정합니다.' },
          { t: '변형 만들기', b: '에이전트가 일반 작업으로 만들고, 같은 프리뷰, 감사, 리뷰를 거칩니다.' },
          { t: '측정', b: 'Evolve가 어떤 변형이 라이브인지 추적하고 각각을 목표에 비춰 평가합니다.' },
          { t: '최고만 남기기', b: '진 변형은 정리되고, 이긴 변형이 다음 세대를 만드는 작업의 출발점이 됩니다.' },
        ],
      },
    ],
    beta: '베타',
    handsOff: '에이전트에게 넘기는 것',

    youH: '당신이 개입하는 곳',
    you: [
      { t: '무엇을 만들지', b: '티켓을 쓰고 우선순위를 정하거나, Evolve 목표를 정합니다.' },
      { t: '그것이 맞는지', b: '프리뷰를 써 보고, diff를 읽고, 승인하거나 돌려보냅니다.' },
      { t: '언제 배포할지', b: '머지하고 배포합니다.' },
    ],
    youNote: '나머지는 에이전트가 합니다.',

    ctaH: '실제 프로젝트에서 확인하세요.',
    ctaDeck: 'RunHQ 프로젝트는 실제 티켓, 에이전트 작업, 배포가 담긴 공개 보드를 가질 수 있습니다.',
    ctaBoard: '라이브 보드 열기 ↗',
    ctaTalk: '영업팀 문의',
    ctaDocs: '문서 읽기',
  },
} as const;

const num = (i: number) => String(i + 1).padStart(2, '0');

export default function HowItWorksPage() {
  const t = useT(HIW_T);
  const lp = useLocalePath();

  return (
    <div className="rhn-root">
      <style>{HOME_CHROME_STYLES + HIW_STYLES}</style>
      <HomeNav source="how_it_works" />

      <header className="rhh-hero">
        <p className="rhh-eyebrow">{t.eyebrow}</p>
        <h1 className="rhh-h1">{t.h1A}<em>{t.h1B}</em></h1>
        <p className="rhh-lede">{t.lede}</p>
        <ol className="rhh-loop">
          {t.loop.map((s, i) => (
            <li key={s.k}>
              <span className="rhh-num">{num(i)}</span>
              <span className="rhh-loop-k">{s.k}</span>
              <span className="rhh-loop-b">{s.b}</span>
            </li>
          ))}
        </ol>
      </header>

      {t.stages.map((stage, si) => (
        <section className="rhh-sec" key={stage.k} aria-labelledby={`rhh-s${si}`}>
          <div className="rhh-wrap">
          <div className="rhh-head">
            <p className="rhh-eyebrow">
              {num(si)} · {stage.k}
              {'beta' in stage && <span className="rhh-beta">{t.beta}</span>}
            </p>
            <h2 id={`rhh-s${si}`} className="rhh-h2">{stage.h}</h2>
            <p className="rhh-deck">{stage.deck}</p>
          </div>
          <ol className="rhh-rows">
            {stage.rows.map((r) => (
              <li key={r.t}>
                <h3 className="rhh-row-t">{r.t}</h3>
                <p className="rhh-row-b">
                  {r.b}
                  {'f' in r && (
                    <span className="rhh-row-f">
                      <span className="rhh-sr">{t.handsOff}: </span>→ {r.f}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ol>
          </div>
        </section>
      ))}

      <section className="rhh-sec" aria-labelledby="rhh-you">
        <div className="rhh-wrap">
        <div className="rhh-head">
          <h2 id="rhh-you" className="rhh-h2">{t.youH}</h2>
          <p className="rhh-deck">{t.youNote}</p>
        </div>
        <ol className="rhh-rows">
          {t.you.map((r) => (
            <li key={r.t}>
              <h3 className="rhh-row-t">{r.t}</h3>
              <p className="rhh-row-b">{r.b}</p>
            </li>
          ))}
        </ol>
        </div>
      </section>

      <section className="rhh-cta">
        <h2 className="rhh-cta-h">{t.ctaH}</h2>
        <p className="rhh-cta-d">{t.ctaDeck}</p>
        <div className="rhh-cta-row">
          <a className="rhh-btn" href={SHOWCASE_BOARD_URL}>{t.ctaBoard}</a>
          <TalkToUsButton className="rhh-btn rhh-btn-ghost" cta="how_it_works_cta">{t.ctaTalk}</TalkToUsButton>
          <Link className="rhh-cta-link" to={lp('/docs')}>{t.ctaDocs} →</Link>
        </div>
      </section>

      <HomeFooter source="how_it_works" />
    </div>
  );
}

const HIW_STYLES = `
  .rhh-hero { max-width: 1040px; margin: 0 auto; padding: clamp(56px, 10vh, 120px) var(--rhn-pad) 128px; }
  .rhh-eyebrow {
    display: flex; align-items: center; gap: 10px;
    margin: 0 0 20px;
    font: 400 12px var(--rhn-mono); letter-spacing: .08em; text-transform: uppercase;
    color: var(--rhn-mute);
  }
  .rhh-h1 {
    margin: 0;
    font: 400 clamp(52px, 6.4vw, 104px)/0.98 var(--rhn-serif);
    letter-spacing: -.03em; text-wrap: balance;
  }
  .rhh-lede {
    margin: 32px 0 0; max-width: 620px;
    font: 400 19px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty;
  }
  .rhh-loop, .rhh-rows { list-style: none; margin: 0; padding: 0; }
  .rhh-num { font: 400 12px var(--rhn-mono); color: var(--rhn-mute); }

  .rhh-loop {
    display: grid; grid-template-columns: repeat(3, 1fr);
    margin-top: 80px; border-top: 1px solid var(--rhn-ink);
  }
  .rhh-loop > li { display: flex; flex-direction: column; gap: 10px; padding: 24px 28px 0 0; }
  .rhh-loop > li + li { padding-left: 28px; border-left: 1px solid var(--rhn-rule); }
  .rhh-loop-k { font: 400 40px/1 var(--rhn-serif); letter-spacing: -.02em; }
  .rhh-loop-b { font: 400 15px/1.5 var(--rhn-sans); color: var(--rhn-mute); }

  .rhh-sec { border-top: 1px solid var(--rhn-rule); padding: 112px var(--rhn-pad); }
  .rhh-wrap {
    display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 64px;
    max-width: 1040px; margin: 0 auto;
  }
  .rhh-head { align-self: start; position: sticky; top: 40px; }
  .rhh-h2 {
    margin: 0;
    font: 400 clamp(36px, 3.8vw, 52px)/1.02 var(--rhn-serif);
    letter-spacing: -.03em; text-wrap: balance;
  }
  .rhh-deck { margin: 20px 0 0; font: 400 16px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty; }
  .rhh-beta {
    padding: 1px 8px; border: 1px solid var(--rhn-mute); border-radius: 999px;
    text-transform: none; letter-spacing: .02em;
  }

  .rhh-rows { border-top: 1px solid var(--rhn-ink); counter-reset: rhh; }
  .rhh-rows > li {
    counter-increment: rhh;
    display: grid; grid-template-columns: 40px minmax(0, 1fr); column-gap: 16px;
    padding: 24px 0; border-bottom: 1px solid #b9b7af;
  }
  .rhh-rows > li::before {
    content: counter(rhh, decimal-leading-zero);
    grid-row: span 2; padding-top: 4px;
    font: 400 12px var(--rhn-mono); color: var(--rhn-mute);
  }
  .rhh-row-t { margin: 0 0 6px; font: 500 17px/1.35 var(--rhn-sans); }
  .rhh-row-b { margin: 0; font: 400 15px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty; }
  .rhh-row-f { display: block; margin-top: 10px; color: var(--rhn-ink); }
  .rhh-sr {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }

  .rhh-cta {
    background: var(--rhn-ink); color: #e8e6df;
    padding: 140px var(--rhn-pad); text-align: center;
    display: flex; flex-direction: column; align-items: center;
  }
  .rhh-cta-h { margin: 0; font: 400 clamp(40px, 5.2vw, 80px)/1.02 var(--rhn-serif); letter-spacing: -.03em; }
  .rhh-cta-d { margin: 20px 0 40px; max-width: 520px; font: 400 17px/1.55 var(--rhn-sans); color: #a8a69e; }
  .rhh-cta-row { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 16px 24px; }
  .rhn-root .rhh-btn {
    background: #e8e6df; color: var(--rhn-ink);
    padding: 12px 22px; border-radius: 999px; font: 400 15px var(--rhn-sans);
  }
  .rhn-root .rhh-btn-ghost { background: transparent; color: #e8e6df; border: 1px solid #5c5b55; }
  .rhh-cta-link { font: 400 15px var(--rhn-sans); color: #a8a69e; }

  @media (max-width: 860px) {
    .rhh-wrap { grid-template-columns: 1fr; gap: 40px; }
    .rhh-head { position: static; }
  }
  @media (max-width: 720px) {
    .rhh-hero { padding-top: 56px; padding-bottom: 88px; }
    .rhh-lede { font-size: 17px; }
    .rhh-loop { grid-template-columns: 1fr; margin-top: 56px; }
    .rhh-loop > li { padding: 20px 0; }
    .rhh-loop > li + li { padding-left: 0; border-left: 0; border-top: 1px solid var(--rhn-rule); }
    .rhh-sec { padding-top: 80px; padding-bottom: 80px; }
    .rhh-cta { padding-top: 96px; padding-bottom: 96px; }
  }
`;
