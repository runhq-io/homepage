import { Link } from 'react-router-dom';
import { HomeNav, HomeFooter, HOME_CHROME_STYLES, SHOWCASE_BOARD_URL } from '../components/homeChrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { useT, useLocalePath } from '../i18n/context';

/**
 * /how-it-works: follows one change from a user's report to a shipped fix,
 * then how the product keeps improving, then who does what.
 *
 * Plain language on purpose: no product jargon (worktrees, audits,
 * generations). Same copy rules as the homepage: no em dashes, the product is
 * live, and only claims true today.
 */
const HIW_T = {
  en: {
    eyebrow: 'How it works',
    h1A: 'You decide what to build. ',
    h1B: 'Agents do the rest.',
    lede: 'RunHQ connects your users, AI coding agents and you in one loop. Users tell you what is wrong, agents fix it, you approve, and it ships. Here is one change, start to finish.',

    flowH: 'Follow one change',
    flow: [
      { who: 'User', t: 'A user hits a problem.', b: 'Jen can’t pay on Safari, so she reports it from the chat widget in your app. It could just as well come from an email, an error alert or a teammate.' },
      { who: 'RunHQ', t: 'It becomes a ticket.', b: 'Her message, the page she was on and any errors are attached automatically, and an AI agent (Claude Code or Codex) is assigned.' },
      { who: 'Agent', t: 'An agent writes the fix.', b: 'It works on its own copy of your code, so nothing live is touched. Several agents can work at once.' },
      { who: 'RunHQ', t: 'It’s checked and previewed.', b: 'The code is reviewed automatically and any problems go back to the agent. You get a working preview to click through.' },
      { who: 'You', you: true, t: 'You approve.', b: 'Looks right? Approve it. Not quite? Send it back with a comment.' },
      { who: 'RunHQ', t: 'It ships, and Jen hears back.', b: 'RunHQ merges and deploys the fix, then replies to Jen in the widget.' },
    ],

    moreH: 'Then it keeps improving',
    more: [
      { t: 'Problems find you.', b: 'Errors, support messages and the steps where users drop off become tickets on their own.' },
      { t: 'It tests better versions.', beta: true, b: 'Set a goal, like more completed checkouts. Agents build a few versions, RunHQ measures them with your analytics, and the best one stays.' },
      { t: 'The loop repeats.', b: 'Every release brings new feedback, and any of it can become the next fix.' },
    ],
    beta: 'beta',

    whoH: 'Who does what',
    you: 'You',
    youList: ['Decide what matters', 'Try the preview', 'Approve or send it back'],
    them: 'RunHQ and its agents',
    themList: ['Collect feedback and errors', 'Write and check the code', 'Ship it and reply to users'],

    ctaH: 'See it running.',
    ctaDeck: 'ARRR’s board is public: every ticket, agent and release, live.',
    ctaBoard: 'Open the ARRR board ↗',
    ctaTalk: 'Contact sales',
    ctaDocs: 'Read the docs',
  },
  ko: {
    eyebrow: '작동 방식',
    h1A: '무엇을 만들지는 당신이 정합니다. ',
    h1B: '나머지는 에이전트가 합니다.',
    lede: 'RunHQ는 사용자, AI 코딩 에이전트, 그리고 당신을 하나의 루프로 연결합니다. 사용자가 문제를 알리면 에이전트가 고치고, 당신이 승인하면 배포됩니다. 변경 하나가 처음부터 끝까지 어떻게 가는지 보세요.',

    flowH: '변경 하나 따라가기',
    flow: [
      { who: '사용자', t: '사용자가 문제를 겪습니다.', b: 'Jen이 Safari에서 결제를 못 해서 앱 안의 채팅 위젯으로 알립니다. 이메일, 에러 알림, 팀원에게서 들어올 수도 있습니다.' },
      { who: 'RunHQ', t: '티켓이 됩니다.', b: '메시지, 보던 페이지, 에러가 자동으로 붙고, AI 에이전트(Claude Code 또는 Codex)가 배정됩니다.' },
      { who: '에이전트', t: '에이전트가 수정합니다.', b: '코드의 별도 사본에서 작업하므로 라이브 서비스는 건드리지 않습니다. 여러 에이전트가 동시에 일할 수 있습니다.' },
      { who: 'RunHQ', t: '검사하고 미리 봅니다.', b: '코드는 자동으로 검토되고 문제는 에이전트에게 돌아갑니다. 당신은 직접 눌러 볼 수 있는 프리뷰를 받습니다.' },
      { who: '당신', you: true, t: '당신이 승인합니다.', b: '괜찮으면 승인하고, 아니면 코멘트와 함께 돌려보내세요.' },
      { who: 'RunHQ', t: '배포되고, Jen이 답을 받습니다.', b: 'RunHQ가 수정을 머지하고 배포한 뒤 위젯으로 Jen에게 답장합니다.' },
    ],

    moreH: '그리고 계속 나아집니다',
    more: [
      { t: '문제가 먼저 찾아옵니다.', b: '에러, 고객 문의, 사용자가 이탈하는 단계가 저절로 티켓이 됩니다.' },
      { t: '더 나은 버전을 시험합니다.', beta: true, b: '결제 완료 늘리기 같은 목표를 정하세요. 에이전트가 몇 가지 버전을 만들고, RunHQ가 애널리틱스로 측정해 가장 좋은 것을 남깁니다.' },
      { t: '루프가 반복됩니다.', b: '배포마다 새 피드백이 생기고, 그중 무엇이든 다음 수정이 될 수 있습니다.' },
    ],
    beta: '베타',

    whoH: '누가 무엇을 하나',
    you: '당신',
    youList: ['무엇이 중요한지 정하기', '프리뷰 써 보기', '승인하거나 돌려보내기'],
    them: 'RunHQ와 에이전트',
    themList: ['피드백과 에러 모으기', '코드 작성하고 검사하기', '배포하고 사용자에게 답하기'],

    ctaH: '실제로 돌아가는 모습을 보세요.',
    ctaDeck: 'ARRR의 보드는 공개되어 있습니다. 모든 티켓, 에이전트, 배포를 실시간으로.',
    ctaBoard: 'ARRR 보드 열기 ↗',
    ctaTalk: '영업팀 문의',
    ctaDocs: '문서 읽기',
  },
} as const;

export default function HowItWorksPage() {
  const t = useT(HIW_T);
  const lp = useLocalePath();

  return (
    <div className="rhn-root">
      <style>{HOME_CHROME_STYLES + HIW_STYLES}</style>
      <HomeNav source="how_it_works" />

      <main className="rhh-col">
        <header>
          <p className="rhh-eyebrow">{t.eyebrow}</p>
          <h1 className="rhh-h1">{t.h1A}<em>{t.h1B}</em></h1>
          <p className="rhh-lede">{t.lede}</p>
        </header>

        <section aria-labelledby="rhh-flow">
          <h2 id="rhh-flow" className="rhh-h2">{t.flowH}</h2>
          <ol className="rhh-flow">
            {t.flow.map((s) => (
              <li key={s.t} className={'you' in s ? 'rhh-flow-you' : undefined}>
                <span className="rhh-who">{s.who}</span>
                <div>
                  <h3 className="rhh-t">{s.t}</h3>
                  <p className="rhh-b">{s.b}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="rhh-more">
          <h2 id="rhh-more" className="rhh-h2">{t.moreH}</h2>
          <ul className="rhh-more">
            {t.more.map((m) => (
              <li key={m.t}>
                <h3 className="rhh-t">
                  {m.t}
                  {'beta' in m && <span className="rhh-beta">{t.beta}</span>}
                </h3>
                <p className="rhh-b">{m.b}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="rhh-who">
          <h2 id="rhh-who" className="rhh-h2">{t.whoH}</h2>
          <div className="rhh-who-grid">
            <div>
              <h3 className="rhh-who-h">{t.you}</h3>
              <ul>{t.youList.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div>
              <h3 className="rhh-who-h">{t.them}</h3>
              <ul>{t.themList.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          </div>
        </section>
      </main>

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
  .rhh-col { max-width: 680px; margin: 0 auto; padding: 40px var(--rhn-pad) 96px; }
  .rhh-col section { margin-top: 72px; }
  .rhh-col ol, .rhh-col ul { list-style: none; margin: 0; padding: 0; }

  .rhh-eyebrow {
    margin: 0 0 16px;
    font: 400 12px var(--rhn-mono); letter-spacing: .08em; text-transform: uppercase;
    color: var(--rhn-mute);
  }
  .rhh-h1 {
    margin: 0;
    font: 400 clamp(44px, 5.4vw, 68px)/1 var(--rhn-serif);
    letter-spacing: -.03em; text-wrap: balance;
  }
  .rhh-lede { margin: 24px 0 0; font: 400 18px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty; }
  .rhh-h2 { margin: 0 0 12px; font: 400 34px/1.1 var(--rhn-serif); letter-spacing: -.02em; }
  .rhh-t { margin: 0; font: 500 17px/1.4 var(--rhn-sans); display: flex; align-items: center; gap: 10px; }
  .rhh-b { margin: 4px 0 0; font: 400 15px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty; }

  /* The flow: who acts on the left, a rail with a dot per step on the right. */
  .rhh-flow > li { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 20px; padding: 16px 0; }
  .rhh-flow > li > div { position: relative; padding-left: 28px; }
  .rhh-flow > li > div::before {
    content: ''; position: absolute; left: 0; top: 7px;
    width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box;
    background: var(--rhn-bg); border: 1.5px solid var(--rhn-ink);
  }
  .rhh-flow > li > div::after {
    content: ''; position: absolute; left: 4px; top: 20px; bottom: -28px;
    border-left: 1px solid var(--rhn-rule);
  }
  .rhh-flow > li:last-child > div::after { display: none; }
  .rhh-flow-you > div::before { background: var(--rhn-ink) !important; }
  .rhh-who {
    padding-top: 3px; text-align: right;
    font: 400 12px var(--rhn-mono); letter-spacing: .04em; color: var(--rhn-mute);
  }
  .rhh-flow-you .rhh-who { color: var(--rhn-ink); }

  .rhh-more { border-top: 1px solid var(--rhn-ink); }
  .rhh-more > li { padding: 16px 0; border-bottom: 1px solid #b9b7af; }
  .rhh-beta {
    padding: 1px 8px; border: 1px solid var(--rhn-mute); border-radius: 999px;
    font: 400 11px var(--rhn-mono); color: var(--rhn-mute);
  }

  .rhh-who-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .rhh-who-grid > div { border-top: 1px solid var(--rhn-ink); padding-top: 14px; }
  .rhh-who-h { margin: 0 0 4px; font: 400 12px var(--rhn-mono); letter-spacing: .08em; text-transform: uppercase; }
  .rhh-who-grid li { padding: 10px 0; font: 400 15px/1.5 var(--rhn-sans); border-bottom: 1px solid #b9b7af; }

  .rhh-cta {
    background: var(--rhn-ink); color: #e8e6df;
    padding: 88px var(--rhn-pad); text-align: center;
    display: flex; flex-direction: column; align-items: center;
  }
  .rhh-cta-h { margin: 0; font: 400 clamp(36px, 4.4vw, 56px)/1.05 var(--rhn-serif); letter-spacing: -.03em; }
  .rhh-cta-d { margin: 16px 0 32px; max-width: 520px; font: 400 16px/1.55 var(--rhn-sans); color: #a8a69e; }
  .rhh-cta-row { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 16px 24px; }
  .rhn-root .rhh-btn {
    background: #e8e6df; color: var(--rhn-ink);
    padding: 12px 22px; border-radius: 999px; font: 400 15px var(--rhn-sans);
  }
  .rhn-root .rhh-btn-ghost { background: transparent; color: #e8e6df; border: 1px solid #5c5b55; }
  .rhh-cta-link { font: 400 15px var(--rhn-sans); color: #a8a69e; }

  @media (max-width: 720px) {
    .rhh-col { padding-top: 24px; }
    .rhh-col section { margin-top: 56px; }
    .rhh-lede { font-size: 17px; }
    .rhh-h2 { font-size: 30px; }
    /* Stack the actor above each step; the rail stays on the left. */
    .rhh-flow > li { grid-template-columns: 1fr; gap: 4px; position: relative; padding-left: 28px; }
    .rhh-flow > li > div { position: static; padding-left: 0; }
    .rhh-flow > li > div::before { top: 20px; }
    .rhh-flow > li > div::after { top: 33px; bottom: -20px; }
    .rhh-who { text-align: left; padding-top: 0; }
    .rhh-who-grid { grid-template-columns: 1fr; gap: 24px; }
  }
`;
