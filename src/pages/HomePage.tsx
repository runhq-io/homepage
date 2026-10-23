import { useEffect, useState } from 'react';
import { Navbar, Footer, Wordmark, LOGOS, LOGIN_URL } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { trackSignInClick } from '../telemetry';
import { useT } from '../i18n/context';
import { API_BASE } from '../widget';
import arrrCover from '../assets/arrr-cover.jpg';

const HOME_T = {
  en: {
    // Hero
    heroH1: 'Your product, built and run by agents.',
    heroLede: 'Write a ticket. Claude Code or Codex works it in its own branch, opens a pull request, and ships it once you approve. After launch, RunHQ also runs your inbox, error tracking and experiments, and anything they turn up becomes the next ticket.',
    ctaTalk: 'Talk to us',
    ctaBoard: 'See a live board',
    // Hero status rail: the six real ticket statuses, in order
    railAria: 'One ticket moving through RunHQ',
    railReplay: 'Replay',
    status1: 'Pending',
    status2: 'In progress',
    status3: 'Done',
    status4: 'Reviewed',
    status5: 'Merged',
    status6: 'Deployed',
    ticketTitle: 'Safari drops the Stripe session at checkout',
    ticketFrom: 'Filed from the widget by Jen K.',
    stage1: 'Waiting for an agent. You can add screenshots, logs or a repro first.',
    stage2: 'Codex is working on ticket-4821, with its own worktree and preview.',
    stage3: 'Pull request #212 opened. The audit found nothing to fix.',
    stage4: 'You read the diff, tried the preview and approved it.',
    stage5: 'Merged into main.',
    stage6: 'Live in production. Jen gets a reply in the widget.',
    // Logos
    logosH: 'Teams shipping on RunHQ',
    // Build
    buildH2: 'From ticket to production',
    buildDeck: 'Every change follows the same path, and you only step in where judgment matters: what to build and whether it is right.',
    build1T: 'Write a ticket',
    build1B: 'Type it, dictate it, or let it arrive on its own from the widget, the error tracker or a failed deploy. Attach screenshots and logs; agents use them.',
    build1A: 'Bulk archive in the projects table',
    build2T: 'An agent takes it',
    build2B: 'Each job gets its own worktree, branch, terminal and chat. Run as many in parallel as you like, and switch a job between Claude Code and Codex without losing its place.',
    build2A: 'Codex is running on ticket-4821',
    build3T: 'Try it before it merges',
    build3B: 'Every worktree has its own preview of your app, so you click through the change instead of imagining it from a diff.',
    build3A: 'Preview for ticket-4821 is ready',
    build4T: 'Audit and review',
    build4B: 'The pull request is audited automatically, and findings go straight back to the agent that wrote it. You review the diff in Git when it is clean.',
    build4A: 'git push && runhq ready-for-review',
    build5T: 'Merge and deploy',
    build5B: 'Merge with one shortcut. Each deploy shows exactly which tickets it carries, and a failed deploy offers a ticket to fix itself.',
    build5A: 'Next deploy: 6 tickets',
    // Run
    runH2: 'After it ships, it keeps listening',
    runDeck: 'The tools that run a live product sit in the same workspace as the agents, so whatever users run into can become work without being copied anywhere.',
    runColTool: 'Tool',
    runColDoes: 'What it does',
    runColFiles: 'What it hands the agents',
    run1T: 'CRM and inbox',
    run1D: 'Email on your own domain, SMS, WhatsApp, calls and a help centre, with one timeline per person. A support agent answers from your knowledge base.',
    run1F: 'Requests worth building',
    run2T: 'Widget',
    run2D: 'A chat and feedback board inside your app. Users report, vote and follow along without making an account.',
    run2F: 'Bug reports with the page and user attached',
    run3T: 'Errors',
    run3D: 'Errors from your app and server, grouped by cause.',
    run3F: 'A fix ticket in one click, with an agent on it',
    run4T: 'Analytics',
    run4D: 'Funnels for what first-time users actually do.',
    run4F: 'The step where people drop off',
    run5T: 'Evolve',
    run5Beta: 'beta',
    run5D: 'Tracks which variations are live and assesses them against Mixpanel, PostHog or your own data.',
    run5F: 'Jobs that build the next generation',
    // Showcase: live boards
    showcaseH2: 'Real projects, running right now',
    showcaseDeck: 'Every RunHQ project can have a public board with its real tickets, agent work and deploys. Open one and watch it move.',
    showcaseOpenBoard: 'Open the live board',
    showcaseOpen: 'Open board',
    showcaseLive: 'live',
    showcaseStatTicketsWeek: 'tickets this week',
    showcaseStatContributors: 'contributors',
    showcaseStatDeploysWeek: 'deploys this week',
    showcaseStatTicketsTotal: 'tickets so far',
    showcaseArrrName: 'ARRR',
    showcaseArrrTagline: 'A voxel pirate game whose players vote on features and agents build them.',
    showcaseArrrArtAlt: 'ARRR, a voxel pirate game built on RunHQ',
    showcaseRunhqName: 'RunHQ',
    showcaseRunhqTagline: 'Our own board. We build RunHQ on RunHQ.',
    showcaseModdioName: 'Moddio',
    showcaseModdioTagline: 'A game platform turning player feedback into agent-built changes.',
    // Where it runs
    whereH2: 'Runs where you want it',
    where1T: 'Cloud workspace',
    where1B: 'Describe what you want to build and get a hosted workspace with a Claude Code and a Codex agent ready to go.',
    where2T: 'Your own machine',
    where2B: 'Connect a computer you already have with one Docker command. Your code stays where it is.',
    where3T: 'Desktop and phone',
    where3B: 'Desktop, iOS and Android apps, so you can answer a stuck agent or approve a merge from anywhere.',
    // Closing
    ctaH: 'Write your first ticket today.',
    ctaDeck: 'Tell us what you are building and we will set up a workspace with you.',
    ctaSignIn: 'Sign in',
  },
  ko: {
    // Hero
    heroH1: '에이전트가 만들고 운영하는 당신의 제품.',
    heroLede: '티켓을 쓰세요. Claude Code나 Codex가 자기 브랜치에서 작업하고, 풀 리퀘스트를 열고, 승인하면 배포합니다. 출시 후에는 RunHQ가 인박스, 에러 추적, 실험까지 맡고, 거기서 나온 것은 다음 티켓이 됩니다.',
    ctaTalk: '문의하기',
    ctaBoard: '라이브 보드 보기',
    railAria: 'RunHQ를 거쳐 가는 티켓 하나',
    railReplay: '다시 보기',
    status1: '대기',
    status2: '진행 중',
    status3: '완료',
    status4: '리뷰됨',
    status5: '머지됨',
    status6: '배포됨',
    ticketTitle: 'Safari에서 결제 중 Stripe 세션이 끊김',
    ticketFrom: 'Jen K.님이 위젯으로 접수',
    stage1: '에이전트를 기다리는 중. 먼저 스크린샷, 로그, 재현 방법을 붙일 수 있습니다.',
    stage2: 'Codex가 자체 워크트리와 프리뷰를 갖춘 ticket-4821에서 작업 중입니다.',
    stage3: '풀 리퀘스트 #212가 열렸습니다. 감사에서 고칠 점이 없었습니다.',
    stage4: 'diff를 읽고, 프리뷰를 써 보고, 승인했습니다.',
    stage5: 'main에 머지됐습니다.',
    stage6: '프로덕션에 반영됐습니다. Jen에게 위젯으로 답장이 갑니다.',
    logosH: 'RunHQ로 배포하는 팀들',
    buildH2: '티켓에서 프로덕션까지',
    buildDeck: '모든 변경은 같은 길을 갑니다. 당신은 판단이 필요한 곳, 즉 무엇을 만들지와 그것이 맞는지에만 개입하면 됩니다.',
    build1T: '티켓 작성',
    build1B: '직접 쓰거나, 받아쓰거나, 위젯, 에러 추적, 실패한 배포에서 저절로 들어오게 하세요. 스크린샷과 로그를 붙이면 에이전트가 활용합니다.',
    build1A: '프로젝트 테이블에서 일괄 아카이브',
    build2T: '에이전트가 맡음',
    build2B: '작업마다 자체 워크트리, 브랜치, 터미널, 채팅이 생깁니다. 원하는 만큼 병렬로 돌리고, 진행 상황을 잃지 않고 Claude Code와 Codex 사이를 전환하세요.',
    build2A: 'Codex가 ticket-4821에서 실행 중',
    build3T: '머지 전에 직접 써 보기',
    build3B: '워크트리마다 앱 프리뷰가 있어서, diff로 상상하는 대신 변경 사항을 직접 클릭해 볼 수 있습니다.',
    build3A: 'ticket-4821 프리뷰 준비됨',
    build4T: '감사와 리뷰',
    build4B: '풀 리퀘스트는 자동으로 감사되고, 지적 사항은 작성한 에이전트에게 바로 돌아갑니다. 깔끔해지면 Git에서 diff를 리뷰하세요.',
    build4A: 'git push && runhq ready-for-review',
    build5T: '머지와 배포',
    build5B: '단축키 하나로 머지하세요. 배포마다 어떤 티켓이 실렸는지 보이고, 실패한 배포는 스스로 고칠 티켓을 제안합니다.',
    build5A: '다음 배포: 티켓 6개',
    runH2: '배포 후에도 계속 듣습니다',
    runDeck: '라이브 제품을 운영하는 도구가 에이전트와 같은 워크스페이스에 있어서, 사용자가 겪은 일이 어디에도 옮겨 적지 않고 바로 작업이 됩니다.',
    runColTool: '도구',
    runColDoes: '하는 일',
    runColFiles: '에이전트에게 넘기는 것',
    run1T: 'CRM과 인박스',
    run1D: '자체 도메인 이메일, SMS, WhatsApp, 전화, 헬프 센터를 사람별 타임라인 하나로. 지원 에이전트가 지식 베이스로 답합니다.',
    run1F: '만들 가치가 있는 요청',
    run2T: '위젯',
    run2D: '앱 안의 채팅과 피드백 보드. 사용자는 계정 없이 신고하고, 투표하고, 진행 상황을 지켜봅니다.',
    run2F: '페이지와 사용자 정보가 붙은 버그 리포트',
    run3T: '에러',
    run3D: '앱과 서버의 에러를 원인별로 묶어 보여줍니다.',
    run3F: '클릭 한 번으로 수정 티켓과 담당 에이전트',
    run4T: '애널리틱스',
    run4D: '처음 온 사용자가 실제로 무엇을 하는지 보여주는 퍼널.',
    run4F: '사람들이 떠나는 단계',
    run5T: 'Evolve',
    run5Beta: '베타',
    run5D: '어떤 변형이 라이브인지 추적하고 Mixpanel, PostHog, 자체 데이터로 평가합니다.',
    run5F: '다음 세대를 만드는 작업',
    showcaseH2: '지금 돌아가는 실제 프로젝트',
    showcaseDeck: 'RunHQ 프로젝트는 실제 티켓, 에이전트 작업, 배포가 담긴 공개 보드를 가질 수 있습니다. 하나 열어서 움직이는 걸 보세요.',
    showcaseOpenBoard: '라이브 보드 열기',
    showcaseOpen: '보드 열기',
    showcaseLive: '라이브',
    showcaseStatTicketsWeek: '이번 주 티켓',
    showcaseStatContributors: '기여자',
    showcaseStatDeploysWeek: '이번 주 배포',
    showcaseStatTicketsTotal: '누적 티켓',
    showcaseArrrName: 'ARRR',
    showcaseArrrTagline: '플레이어가 기능에 투표하고 에이전트가 만드는 복셀 해적 게임.',
    showcaseArrrArtAlt: 'ARRR, RunHQ로 만든 복셀 해적 게임',
    showcaseRunhqName: 'RunHQ',
    showcaseRunhqTagline: '우리 자신의 보드. RunHQ는 RunHQ 위에서 만들어집니다.',
    showcaseModdioName: 'Moddio',
    showcaseModdioTagline: '플레이어 피드백을 에이전트가 만든 변경으로 바꾸는 게임 플랫폼.',
    whereH2: '원하는 곳에서 실행',
    where1T: '클라우드 워크스페이스',
    where1B: '만들고 싶은 것을 설명하면 Claude Code와 Codex 에이전트가 준비된 호스팅 워크스페이스가 생깁니다.',
    where2T: '내 컴퓨터',
    where2B: 'Docker 명령 하나로 이미 가진 컴퓨터를 연결하세요. 코드는 그 자리에 그대로 있습니다.',
    where3T: '데스크톱과 휴대폰',
    where3B: '데스크톱, iOS, Android 앱으로 막힌 에이전트에 답하거나 머지를 승인하세요. 어디서든.',
    ctaH: '오늘 첫 티켓을 써 보세요.',
    ctaDeck: '무엇을 만들고 있는지 알려주시면 함께 워크스페이스를 준비해 드립니다.',
    ctaSignIn: '로그인',
  },
} as const;

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
  // `quiet`: the live API reported no tickets this week, so the card shows the
  // all-time total instead of a row of zeros.
  arrr: { ticketsWeek: number; contributors: number; deploysWeek: number; quiet: boolean };
  totals: { arrr: number; runhq: number; moddio: number };
};

function useBoardStats(): ShowcaseStats {
  const [stats, setStats] = useState<ShowcaseStats>({
    arrr: {
      ticketsWeek: SHOWCASE_FALLBACK.arrr.ticketsWeek,
      contributors: SHOWCASE_FALLBACK.arrr.contributors,
      deploysWeek: SHOWCASE_FALLBACK.arrr.deploysWeek,
      quiet: false,
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
            quiet: d.ticketsCreated7d === 0,
          },
        }));
      })
      .catch(() => {/* keep fallbacks */});

    return () => ctrl.abort();
  }, []);

  return stats;
}

const LAST_STEP = 5;

/**
 * The hero's signature: one ticket walking the six real ticket statuses
 * (pending → in progress → done → reviewed → merged → deployed). It plays once,
 * then rests on Deployed with a Replay button. Clicking any status jumps to it
 * and stops the autoplay. Reduced motion starts (and stays) on Deployed.
 */
function TicketRail() {
  const t = useT(HOME_T);
  const statuses = [t.status1, t.status2, t.status3, t.status4, t.status5, t.status6];
  const stages = [t.stage1, t.stage2, t.stage3, t.stage4, t.stage5, t.stage6];
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setAuto(false);
      setStep(LAST_STEP);
    }
  }, []);

  useEffect(() => {
    if (!auto || step >= LAST_STEP) return;
    const id = window.setTimeout(() => setStep((s) => s + 1), step === 0 ? 1800 : 2000);
    return () => window.clearTimeout(id);
  }, [auto, step]);

  const jump = (i: number) => {
    setAuto(false);
    setStep(i);
  };
  const replay = () => {
    setStep(0);
    setAuto(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  };

  return (
    <figure className="rhh-rail" aria-label={t.railAria}>
      <ol className="rhh-rail-steps">
        {statuses.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              className={`rhh-rail-step ${i < step ? 'is-past' : i === step ? 'is-now' : 'is-next'}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => jump(i)}
            >
              {label}
            </button>
          </li>
        ))}
      </ol>
      <div className="rhh-ticket">
        <div className="rhh-ticket-meter" aria-hidden="true">
          {statuses.map((label, i) => (
            <span key={label} className={i <= step ? 'is-on' : undefined} />
          ))}
        </div>
        <div className="rhh-ticket-title">{t.ticketTitle}</div>
        <div className="rhh-ticket-from">{t.ticketFrom}</div>
        <p className="rhh-ticket-stage" key={step}>
          <strong className={step === 0 ? 'rhh-needs-you' : undefined}>{statuses[step]}.</strong> {stages[step]}
        </p>
        {step === LAST_STEP && (
          <button type="button" className="rhh-replay" onClick={replay}>{t.railReplay}</button>
        )}
      </div>
    </figure>
  );
}

export default function HomePage() {
  const t = useT(HOME_T);
  const boardStats = useBoardStats();

  const BUILD = [
    { title: t.build1T, body: t.build1B, artifact: t.build1A },
    { title: t.build2T, body: t.build2B, artifact: t.build2A },
    { title: t.build3T, body: t.build3B, artifact: t.build3A },
    { title: t.build4T, body: t.build4B, artifact: t.build4A },
    { title: t.build5T, body: t.build5B, artifact: t.build5A },
  ];
  const RUN = [
    { title: t.run1T, does: t.run1D, files: t.run1F },
    { title: t.run2T, does: t.run2D, files: t.run2F },
    { title: t.run3T, does: t.run3D, files: t.run3F },
    { title: t.run4T, does: t.run4D, files: t.run4F },
    { title: t.run5T, does: t.run5D, files: t.run5F, beta: t.run5Beta },
  ];
  const WHERE = [
    { title: t.where1T, body: t.where1B },
    { title: t.where2T, body: t.where2B },
    { title: t.where3T, body: t.where3B },
  ];

  return (
    <div className="rhh-root">
      <style>{HOME_STYLES}</style>
      <Navbar />

      {/* HERO */}
      <section className="rhh-hero">
        <h1 className="rhh-h1">{t.heroH1}</h1>
        <p className="rhh-lede">{t.heroLede}</p>
        <div className="rhh-actions">
          <TalkToUsButton className="rhh-btn rhh-btn-primary" cta="hero">{t.ctaTalk}</TalkToUsButton>
          {/* Boards are never locale-prefixed (see BoardPage.LocalizedBoardRedirect). */}
          <a className="rhh-btn rhh-btn-quiet" href="/arrr">{t.ctaBoard}</a>
        </div>
        <TicketRail />
      </section>

      {/* LOGOS */}
      <section className="rhh-logos" aria-label={t.logosH}>
        <span className="rhh-logos-h">{t.logosH}</span>
        {LOGOS.map((name) => (
          <Wordmark key={name} name={name} size={17} color="var(--rhw-ink-mute)" />
        ))}
      </section>

      {/* BUILD — ticket to production, a genuine sequence */}
      <section className="rhh-build">
        <div className="rhh-build-head">
          <h2 className="rhh-h2">{t.buildH2}</h2>
          <p className="rhh-deck">{t.buildDeck}</p>
        </div>
        <ol className="rhh-steps">
          {BUILD.map((s, i) => (
            <li key={s.title} className="rhh-step">
              <span className="rhh-step-n" aria-hidden="true">{i + 1}</span>
              <div>
                <h3 className="rhh-h3">{s.title}</h3>
                <p className="rhh-body">{s.body}</p>
                <code className="rhh-artifact">{s.artifact}</code>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* RUN — the post-launch tools, and what each hands back to the agents */}
      <section className="rhh-run">
        <h2 className="rhh-h2">{t.runH2}</h2>
        <p className="rhh-deck">{t.runDeck}</p>
        <table className="rhh-ledger">
          <thead>
            <tr>
              <th scope="col">{t.runColTool}</th>
              <th scope="col">{t.runColDoes}</th>
              <th scope="col">{t.runColFiles}</th>
            </tr>
          </thead>
          <tbody>
            {RUN.map((r) => (
              <tr key={r.title}>
                <th scope="row">
                  {r.title}
                  {r.beta && <span className="rhh-beta">{r.beta}</span>}
                </th>
                <td>{r.does}</td>
                <td className="rhh-ledger-files" data-label={t.runColFiles}>{r.files}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* SHOWCASE — real, live project boards */}
      <section className="rhh-show">
        <h2 className="rhh-h2">{t.showcaseH2}</h2>
        <p className="rhh-deck">{t.showcaseDeck}</p>
        <div className="rhh-show-grid">
          <a className="rhh-arrr" href="/arrr">
            <img className="rhh-arrr-art" src={arrrCover} alt={t.showcaseArrrArtAlt} loading="lazy" />
            <div className="rhh-arrr-body">
              <div className="rhh-board-name">
                {t.showcaseArrrName}
                <span className="rhh-live"><span className="rhh-live-dot" />{t.showcaseLive}</span>
              </div>
              <p className="rhh-body">{t.showcaseArrrTagline}</p>
              <dl className="rhh-stats">
                {boardStats.arrr.quiet ? (
                  <div><dt>{t.showcaseStatTicketsTotal}</dt><dd>{boardStats.totals.arrr.toLocaleString()}</dd></div>
                ) : (
                  <>
                    <div><dt>{t.showcaseStatTicketsWeek}</dt><dd>{boardStats.arrr.ticketsWeek.toLocaleString()}</dd></div>
                    <div><dt>{t.showcaseStatContributors}</dt><dd>{boardStats.arrr.contributors.toLocaleString()}</dd></div>
                    <div><dt>{t.showcaseStatDeploysWeek}</dt><dd>{boardStats.arrr.deploysWeek.toLocaleString()}</dd></div>
                  </>
                )}
              </dl>
              <span className="rhh-link">{t.showcaseOpenBoard}</span>
            </div>
          </a>
          <div className="rhh-boards">
            {[
              { slug: 'runhq', name: t.showcaseRunhqName, tagline: t.showcaseRunhqTagline, total: boardStats.totals.runhq },
              { slug: 'moddio', name: t.showcaseModdioName, tagline: t.showcaseModdioTagline, total: boardStats.totals.moddio },
            ].map((b) => (
              <a key={b.slug} className="rhh-board" href={`/${b.slug}`}>
                <div className="rhh-board-name">{b.name}</div>
                <p className="rhh-body">{b.tagline}</p>
                <div className="rhh-board-foot">
                  <span><strong>{b.total.toLocaleString()}</strong> {t.showcaseStatTicketsTotal}</span>
                  <span className="rhh-link">{t.showcaseOpen}</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* WHERE IT RUNS */}
      <section className="rhh-where">
        <h2 className="rhh-h2">{t.whereH2}</h2>
        <div className="rhh-where-grid">
          {WHERE.map((w) => (
            <div key={w.title}>
              <h3 className="rhh-h3">{w.title}</h3>
              <p className="rhh-body">{w.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CLOSING */}
      <section className="rhh-close">
        <h2 className="rhh-close-h">{t.ctaH}</h2>
        <p className="rhh-close-deck">{t.ctaDeck}</p>
        <div className="rhh-actions">
          <TalkToUsButton className="rhh-btn rhh-btn-primary" cta="home_closing">{t.ctaTalk}</TalkToUsButton>
          <a
            className="rhh-btn rhh-btn-onink"
            href={LOGIN_URL}
            onClick={() => trackSignInClick('home_closing')}
          >{t.ctaSignIn}</a>
        </div>
      </section>

      <Footer />
    </div>
  );
}

const HOME_STYLES = `
  /* The homepage's own palette. Overriding the shared --rhw-* tokens on the root
     lets the Navbar and Footer (rendered inside it) pick the palette up too. */
  .rhh-root {
    --rhw-bg:        #F1F2EE;
    --rhw-bg-2:      #E6E8E2;
    --rhw-surface:   #FAFAF8;
    --rhw-ink:       #15171C;
    --rhw-ink-soft:  #3E434C;
    --rhw-ink-mute:  #5D636D;
    --rhw-ink-faint: #8D939C;
    --rhw-line:      #D6D9D1;
    --rhw-line-soft: #E2E4DE;
    --rhw-accent:    #0B7A5C;
    --rhw-accent-soft: rgba(11, 122, 92, 0.10);
    --rhh-amber:     #B26A00;
    --rhh-display:   'Geist', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif;
    --rhh-mono:      'JetBrains Mono', ui-monospace, monospace;
    --rhh-gutter:    clamp(20px, 5vw, 64px);

    background: var(--rhw-bg);
    color: var(--rhw-ink);
    font-family: 'Geist', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .rhh-root *, .rhh-root *::before, .rhh-root *::after { box-sizing: border-box; }
  .rhh-root a { color: inherit; text-decoration: none; }
  .rhh-root :focus-visible { outline: 2px solid var(--rhw-accent); outline-offset: 3px; border-radius: 4px; }

  /* Type scale: 16 / 18 / 22 / 36 / 56 / 96 */
  .rhh-h1 {
    font-family: var(--rhh-display);
    font-size: clamp(44px, 6.4vw, 84px);
    line-height: 1.02;
    letter-spacing: -0.035em;
    font-weight: 600;
    max-width: 13ch;
    margin: 0 0 28px;
    text-wrap: balance;
  }
  .rhh-h2 {
    font-family: var(--rhh-display);
    font-size: clamp(34px, 4.4vw, 56px);
    line-height: 1.04;
    letter-spacing: -0.03em;
    font-weight: 600;
    margin: 0 0 16px;
    max-width: 18ch;
    text-wrap: balance;
  }
  .rhh-h3 {
    font-family: var(--rhh-display);
    font-size: 22px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .rhh-lede {
    font-size: clamp(18px, 1.5vw, 20px);
    line-height: 1.55;
    color: var(--rhw-ink-soft);
    max-width: 60ch;
    margin: 0 0 32px;
    text-wrap: pretty;
  }
  .rhh-deck {
    font-size: 18px;
    color: var(--rhw-ink-soft);
    max-width: 58ch;
    margin: 0 0 48px;
    text-wrap: pretty;
  }
  .rhh-body { color: var(--rhw-ink-soft); margin: 0; max-width: 62ch; text-wrap: pretty; }

  /* Buttons */
  .rhh-actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .rhh-btn {
    display: inline-flex; align-items: center;
    padding: 13px 22px;
    border-radius: 8px;
    font: inherit; font-size: 15px; font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background-color 0.15s, border-color 0.15s;
  }
  .rhh-btn-primary { background: var(--rhw-accent); color: #fff !important; }
  .rhh-btn-primary:hover { background: #086149; }
  .rhh-btn-quiet { border-color: var(--rhw-line); background: var(--rhw-surface); }
  .rhh-btn-quiet:hover { border-color: var(--rhw-ink); }
  .rhh-btn-onink { border-color: rgba(241, 242, 238, 0.28); color: #F1F2EE !important; }
  .rhh-btn-onink:hover { border-color: #F1F2EE; }

  /* Hero */
  .rhh-hero { padding: clamp(48px, 7vw, 96px) var(--rhh-gutter) 72px; }

  /* Hero rail — the one bold moment on the page */
  .rhh-rail { margin: clamp(48px, 6vw, 72px) 0 0; padding-top: 28px; border-top: 1px solid var(--rhw-line); }
  .rhh-rail-steps {
    list-style: none; margin: 0 0 32px; padding: 0;
    display: flex; flex-wrap: wrap; column-gap: clamp(18px, 2.6vw, 40px); row-gap: 8px;
  }
  .rhh-rail-step {
    font-family: var(--rhh-display);
    font-size: clamp(26px, 3.6vw, 48px);
    line-height: 1.15;
    letter-spacing: -0.028em;
    font-weight: 600;
    background: none; border: 0; padding: 0 0 6px; margin: 0;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    transition: color 0.35s ease, border-color 0.35s ease;
  }
  .rhh-rail-step.is-past { color: var(--rhw-ink); }
  .rhh-rail-step.is-now  { color: var(--rhw-accent); border-bottom-color: var(--rhw-accent); }
  .rhh-rail-step.is-next { color: var(--rhw-ink-faint); }
  .rhh-rail-step:hover   { color: var(--rhw-ink); }
  .rhh-rail-step.is-now:hover { color: var(--rhw-accent); }

  .rhh-ticket {
    max-width: 560px;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 10px;
    padding: 20px 22px 22px;
  }
  .rhh-ticket-meter { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin-bottom: 16px; }
  .rhh-ticket-meter span { height: 4px; border-radius: 2px; background: var(--rhw-line-soft); transition: background-color 0.35s ease; }
  .rhh-ticket-meter span.is-on { background: var(--rhw-accent); }
  .rhh-ticket-title { font-weight: 600; font-size: 17px; }
  .rhh-ticket-from { font-size: 14px; color: var(--rhw-ink-mute); margin-top: 2px; }
  .rhh-ticket-stage { margin: 14px 0 0; color: var(--rhw-ink-soft); min-height: 3.1em; animation: rhh-in 0.35s ease; }
  .rhh-ticket-stage strong { color: var(--rhw-accent); font-weight: 600; }
  .rhh-ticket-stage strong.rhh-needs-you { color: var(--rhh-amber); }
  @keyframes rhh-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .rhh-replay {
    margin-top: 12px; padding: 0;
    background: none; border: 0;
    font: inherit; font-size: 14px; font-weight: 500;
    color: var(--rhw-accent); cursor: pointer;
    text-decoration: underline; text-underline-offset: 3px;
  }

  /* Logos */
  .rhh-logos {
    display: flex; flex-wrap: wrap; align-items: center; gap: 16px 36px;
    padding: 24px var(--rhh-gutter);
    border-top: 1px solid var(--rhw-line);
    border-bottom: 1px solid var(--rhw-line);
  }
  .rhh-logos-h { font-size: 14px; color: var(--rhw-ink-mute); }

  /* Build */
  .rhh-build {
    display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 48px;
    padding: clamp(72px, 10vw, 128px) var(--rhh-gutter);
  }
  .rhh-build-head { position: sticky; top: 32px; align-self: start; }
  .rhh-build-head .rhh-deck { margin-bottom: 0; }
  .rhh-steps { list-style: none; margin: 0; padding: 0; }
  .rhh-step {
    display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px;
    padding: 28px 0;
    border-top: 1px solid var(--rhw-line);
  }
  .rhh-step:first-child { border-top: 0; padding-top: 0; }
  .rhh-step-n {
    font-family: var(--rhh-display);
    font-size: 36px; line-height: 1; font-weight: 600;
    color: var(--rhw-ink-faint);
  }
  .rhh-artifact {
    display: inline-block;
    margin-top: 14px;
    padding: 6px 10px;
    font-family: var(--rhh-mono); font-size: 13px;
    color: var(--rhw-ink);
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-left: 3px solid var(--rhw-accent);
    border-radius: 4px;
  }

  /* Run ledger */
  .rhh-run { padding: clamp(72px, 10vw, 128px) var(--rhh-gutter); background: var(--rhw-surface); border-top: 1px solid var(--rhw-line); border-bottom: 1px solid var(--rhw-line); }
  .rhh-ledger { width: 100%; border-collapse: collapse; text-align: left; }
  .rhh-ledger thead th {
    font-size: 14px; font-weight: 500; color: var(--rhw-ink-mute);
    padding: 0 24px 12px 0;
    border-bottom: 1px solid var(--rhw-ink);
  }
  .rhh-ledger tbody th, .rhh-ledger td {
    padding: 22px 24px 22px 0;
    border-bottom: 1px solid var(--rhw-line);
    vertical-align: top;
  }
  .rhh-ledger tbody th {
    width: 22%;
    font-family: var(--rhh-display); font-size: 22px; font-weight: 600; letter-spacing: -0.01em;
  }
  .rhh-ledger td { color: var(--rhw-ink-soft); width: 46%; }
  .rhh-ledger td.rhh-ledger-files { color: var(--rhw-accent); font-weight: 500; width: 32%; }
  .rhh-beta {
    margin-left: 10px; vertical-align: middle;
    font-family: 'Geist', system-ui, sans-serif; font-size: 12px; font-weight: 500; letter-spacing: 0;
    padding: 2px 8px; border-radius: 999px;
    color: var(--rhh-amber); border: 1px solid currentColor;
  }

  /* Showcase */
  .rhh-show { padding: clamp(72px, 10vw, 128px) var(--rhh-gutter); }
  .rhh-show-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 4fr); gap: 24px; }
  .rhh-arrr {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 0.15s;
  }
  .rhh-arrr:hover, .rhh-board:hover { border-color: var(--rhw-ink); }
  .rhh-arrr-art { width: 100%; height: 100%; min-height: 280px; object-fit: cover; display: block; }
  .rhh-arrr-body { padding: 28px; display: flex; flex-direction: column; gap: 18px; }
  .rhh-board-name {
    display: flex; align-items: center; gap: 12px;
    font-family: var(--rhh-display); font-size: 28px; font-weight: 600; letter-spacing: -0.02em;
  }
  .rhh-live {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: 'Geist', system-ui, sans-serif; font-size: 13px; font-weight: 500; letter-spacing: 0;
    color: var(--rhw-accent);
  }
  .rhh-live-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--rhw-accent);
    box-shadow: 0 0 0 3px var(--rhw-accent-soft);
    animation: rhh-pulse 2.4s ease-in-out infinite;
  }
  @keyframes rhh-pulse { 50% { box-shadow: 0 0 0 6px rgba(11, 122, 92, 0.04); } }
  .rhh-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; }
  .rhh-stats div { display: flex; flex-direction: column-reverse; }
  .rhh-stats dt { font-size: 13px; color: var(--rhw-ink-mute); }
  .rhh-stats dd {
    margin: 0;
    font-family: var(--rhh-display); font-size: 36px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .rhh-link {
    margin-top: auto;
    font-weight: 500; color: var(--rhw-accent);
    text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px;
  }
  .rhh-boards { display: flex; flex-direction: column; gap: 24px; }
  .rhh-board {
    flex: 1;
    display: flex; flex-direction: column; gap: 10px;
    padding: 24px;
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    transition: border-color 0.15s;
  }
  .rhh-board .rhh-board-name { font-size: 22px; }
  .rhh-board-foot {
    margin-top: auto; padding-top: 8px;
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    font-size: 14px; color: var(--rhw-ink-mute);
  }
  .rhh-board-foot strong { color: var(--rhw-ink); font-variant-numeric: tabular-nums; }
  .rhh-board-foot .rhh-link { margin-top: 0; }

  /* Where it runs */
  .rhh-where { padding: 0 var(--rhh-gutter) clamp(72px, 10vw, 128px); }
  .rhh-where-grid {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px;
    margin-top: 40px;
  }
  .rhh-where-grid > div { border-top: 2px solid var(--rhw-ink); padding-top: 20px; }

  /* Closing */
  .rhh-close {
    background: var(--rhw-ink);
    color: #F1F2EE;
    padding: clamp(72px, 10vw, 120px) var(--rhh-gutter);
  }
  .rhh-close-h {
    font-family: var(--rhh-display);
    font-size: clamp(40px, 6vw, 80px);
    line-height: 1.02;
    letter-spacing: -0.035em;
    font-weight: 600;
    margin: 0 0 20px;
    max-width: 14ch;
  }
  .rhh-close-deck { font-size: 18px; color: #C4C8CE; margin: 0 0 32px; max-width: 52ch; }

  @media (max-width: 960px) {
    .rhh-build { grid-template-columns: 1fr; }
    .rhh-build-head { position: static; }
    .rhh-show-grid { grid-template-columns: 1fr; }
    .rhh-where-grid { grid-template-columns: 1fr; gap: 28px; }
  }
  @media (max-width: 720px) {
    .rhh-arrr { grid-template-columns: 1fr; }
    .rhh-arrr-art { min-height: 0; aspect-ratio: 16 / 9; }
    .rhh-ledger thead { display: none; }
    .rhh-ledger, .rhh-ledger tbody, .rhh-ledger tr, .rhh-ledger th, .rhh-ledger td { display: block; width: auto !important; }
    .rhh-ledger tr { padding: 20px 0; border-bottom: 1px solid var(--rhw-line); }
    .rhh-ledger tbody th, .rhh-ledger td { padding: 0; border: 0; }
    .rhh-ledger td { margin-top: 6px; }
    .rhh-ledger td.rhh-ledger-files::before {
      content: attr(data-label) ': ';
      color: var(--rhw-ink-mute); font-weight: 400;
    }
    .rhh-step { grid-template-columns: 40px minmax(0, 1fr); }
    .rhh-step-n { font-size: 28px; }
    .rhh-stats dd { font-size: 28px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rhh-root *, .rhh-root *::before, .rhh-root *::after { animation: none !important; transition: none !important; }
  }
`;
