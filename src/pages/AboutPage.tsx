import { Navbar, Footer } from '../components/chrome';
import { TalkToUsButton } from '../components/TalkToUsModal';
import { useT } from '../i18n/context';

const ABOUT_T = {
  en: {
    eyebrow: 'About · RunHQ',
    h1: 'A small team building the operations layer for AI coding agents.',
    lede: 'We started RunHQ because shipping software with agents felt nothing like the rest of our stack. Inboxes for feedback. Boards for tickets. Chat for review. We collapsed it into one loop.',
    factFounded: 'Founded',
    factFoundedV: '2025',
    factHQ: 'Headquartered',
    factHQV: 'Vancouver, BC',
    factTeam: 'Team',
    factTeamV: 'Small, distributed',
    factBackers: 'Backers',
    factBackersV: 'Independent',
    valuesH2: 'What we believe.',
    v1H: 'Loops, not handoffs',
    v1P: 'Feedback, code, review, and ship live in one place. The faster a team closes the loop, the faster the product gets better.',
    v2H: 'Operate the agent',
    v2P: "Coding agents need a workplace, not a chatbox. We're building the operations layer where humans and agents do real work side by side.",
    v3H: 'Boring tooling, fast teams',
    v3P: 'Predictable pricing. Honest defaults. Tools that get out of the way so the team can run.',
    contactH2: 'Get in touch.',
    contactPre: 'Press, partnerships, or anything else — ',
    contactSuffix: '.',
    startFree: 'Talk to us →',
  },
  ko: {
    eyebrow: '소개 · RunHQ',
    h1: 'AI 코딩 에이전트를 위한 운영 레이어를 만드는 작은 팀.',
    lede: '에이전트로 소프트웨어를 출시하는 일은 우리가 평소 쓰던 다른 어떤 도구와도 달랐기에 RunHQ를 시작했습니다. 피드백은 받은편지함에, 티켓은 보드에, 리뷰는 채팅에 흩어져 있던 흐름을 하나의 루프로 합쳤습니다.',
    factFounded: '설립',
    factFoundedV: '2025년',
    factHQ: '본사',
    factHQV: '캐나다 밴쿠버',
    factTeam: '팀',
    factTeamV: '소규모, 분산 근무',
    factBackers: '투자자',
    factBackersV: '독립 운영',
    valuesH2: '우리가 믿는 것.',
    v1H: '인수인계가 아닌 루프',
    v1P: '피드백, 코드, 리뷰, 배포가 한 곳에서 움직입니다. 루프를 빨리 닫는 팀일수록 제품이 더 빠르게 좋아집니다.',
    v2H: '에이전트를 운영하세요',
    v2P: '코딩 에이전트에게 필요한 것은 채팅창이 아니라 일터입니다. 사람과 에이전트가 나란히 진짜 일을 하는 운영 레이어를 만들고 있습니다.',
    v3H: '평범한 도구, 빠른 팀',
    v3P: '예측 가능한 가격. 정직한 기본값. 팀이 달릴 수 있도록 비켜서 주는 도구.',
    contactH2: '문의하기.',
    contactPre: '언론, 파트너십, 그 밖의 무엇이든 — ',
    contactSuffix: '로 보내주세요.',
    startFree: '문의하기 →',
  },
} as const;

export default function AboutPage() {
  const t = useT(ABOUT_T);
  const FACTS = [
    { k: t.factFounded, v: t.factFoundedV },
    { k: t.factHQ, v: t.factHQV },
    { k: t.factTeam, v: t.factTeamV },
    { k: t.factBackers, v: t.factBackersV },
  ];
  const VALUES = [
    { h: t.v1H, p: t.v1P },
    { h: t.v2H, p: t.v2P },
    { h: t.v3H, p: t.v3P },
  ];
  return (
    <div className="rhp-root rha-root">
      <style>{ABOUT_STYLES}</style>
      <Navbar />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">{t.eyebrow}</div>
        <h1 className="rhp-hero-h1">{t.h1}</h1>
        <p className="rhp-hero-lede">{t.lede}</p>
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
        <h2 className="rha-h2">{t.valuesH2}</h2>
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
        <h2 className="rha-h2">{t.contactH2}</h2>
        <p className="rha-contact-p">
          {t.contactPre}<a className="rha-link" href="mailto:admin@runhq.io">admin@runhq.io</a>{t.contactSuffix}
        </p>
        <div className="rha-cta-row">
          <TalkToUsButton className="rhp-btn-primary">{t.startFree}</TalkToUsButton>
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
