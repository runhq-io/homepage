import { Fragment, useState } from 'react';
import { Navbar, Footer, Wordmark, LOGOS, SIGNUP_URL } from '../components/chrome';
import { useT } from '../i18n/context';

type Plan = {
  key: string;
  name: string;
  tag: string;
  monthly: number | null;
  annual: number | null;
  unit: string;
  seat: number | null;
  pitch: string;
  cta: string;
  ghost: boolean;
  popular?: boolean;
  highlights: string[];
};

type Cell = string | boolean;

const PRICING_T = {
  en: {
    eyebrow: 'Pricing · Predictable platform + seats',
    h1: 'Predictable pricing that scales with your team.',
    lede: 'A flat platform fee plus a per-seat charge — no surprises, no usage cliffs. Read-only reviewers are always free.',
    billingMonthly: 'Monthly',
    billingAnnual: 'Annual',
    billingSave: 'Save 25%',
    mostPopular: 'Most popular',
    unitMo: '/mo',
    custom: 'Custom',
    freeSeat: '1 user · no invites',
    seatSuffix: '/seat',
    freeForever: 'free forever',
    billedAnnually: 'billed annually',
    billedMonthly: 'billed monthly',
    pricedToVolume: 'priced to your volume',
    // Plans
    planFreeName: 'Free',
    planFreeTag: 'Kick the tires',
    planFreePitch: 'One user, lowest-tier machine, $5 credit/mo. Upgrade to invite teammates.',
    planFreeCta: 'Start free',
    planFreeH1: '$5 in agent credit / mo',
    planFreeH2: '1 user · no invites',
    planFreeH3: 'Lowest-tier machine only',
    planFreeH4: 'Unlimited concurrent runs',
    planStarterName: 'Starter',
    planStarterTag: 'Best for new teams',
    planStarterPitch: 'Route feedback to any coding agent. Invite the whole team, pick any machine tier.',
    planStarterCta: 'Get started',
    planStarterH1: 'Everything in Free, plus:',
    planStarterH2: '$75 in agent credit / mo',
    planStarterH3: 'All machine tiers',
    planStarterH4: 'Internal feedback widget (team members)',
    planProName: 'Pro',
    planProTag: 'Best for shipping teams',
    planProPitch: 'Public user-facing widget, graph-based agent flow, higher credit.',
    planProCta: 'Get started',
    planProH1: 'Everything in Starter, plus:',
    planProH2: '$200 in agent credit / mo',
    planProH3: 'Public user-facing widget',
    planProH4: 'Graph-based agent flow',
    planEnterpriseName: 'Enterprise',
    planEnterpriseTag: 'Best for regulated org charts',
    planEnterprisePitch: 'Single-tenant deployment, custom DPA, dedicated POC.',
    planEnterpriseCta: 'Contact us',
    planEnterpriseH1: 'Everything in Pro, plus:',
    planEnterpriseH2: 'Single-tenant deployment',
    planEnterpriseH3: 'Custom DPA + MSA',
    planEnterpriseH4: 'Dedicated POC',
    // Trust
    trustH: 'Trusted by 1,400+ teams shipping with agents',
    // Compare
    compareH: 'Compare every feature.',
    compareSub: 'Side-by-side, all four plans, every line item.',
    secWorkspace: 'Workspace',
    secAgents: 'Agents & credit',
    secGovernance: 'Governance',
    rowUsers: 'Users',
    rowTeamInvites: 'Team invites',
    rowProjects: 'Projects',
    rowReviewers: 'Reviewers (read-only)',
    rowInternalWidget: 'Internal widget (team members)',
    rowPublicWidget: 'Public user-facing widget',
    rowMonthlyCredit: 'Monthly agent credit',
    rowClaudeCode: 'Claude Code',
    rowCodex: 'Codex',
    rowBrowserTerm: 'Browser + terminal execution',
    rowGraphFlow: 'Graph-based agent flow',
    rowConcurrent: 'Concurrent runs',
    rowMachineTiers: 'Machine tiers',
    rowProvenance: 'Prompt + diff provenance',
    rowCustomDPA: 'Custom DPA',
    rowSingleTenant: 'Single-tenant deployment',
    cellOne: '1',
    cellUnlimited: 'Unlimited',
    cellNone: 'None',
    cellLowestOnly: 'Lowest only',
    cellAllTiers: 'All tiers',
    cellCustom: 'Custom',
    // Save callout
    saveWhy: 'Why teams switch',
    saveH: 'Replace 3 tools with 1 — save ~$14,000/yr',
    saveP: 'The average RunHQ Pro customer drops their feedback widget, agent ops dashboard, and ticket triage tool. Same loop, one bill.',
    saveRow1T: 'Feedback widget',
    saveRow1V: '$8,400 / yr',
    saveRow2T: 'Agent dashboard',
    saveRow2V: '$7,800 / yr',
    saveRow3T: 'Ticket triage tool',
    saveRow3V: '$3,000 / yr',
    saveTotalT: 'RunHQ Pro, annual (8 seats)',
    saveTotalV: '$4,800 / yr',
    // FAQ
    faqH: 'Frequently asked.',
    faq1Q: 'How does seat pricing work?',
    faq1A: 'You pay a flat platform fee per month plus a per-seat charge for every team member with edit access. Read-only reviewers — designers, support, your CEO — are always free, on every plan.',
    faq2Q: "What's the difference between a seat and a reviewer?",
    faq2A: 'Seats dispatch agents and ship work. Reviewers comment, vote, and watch — read-only, unlimited, free on every plan. Most teams have 3-4× more reviewers than seats.',
    faq3Q: 'How does the monthly agent credit work?',
    faq3A: 'Every plan includes a pool of agent credit that resets at the start of each billing cycle — $5 on Free, $75 on Starter, $200 on Pro. Credit pays for token spend across all supported coding agents. Unused credit does not roll over.',
    faq4Q: 'What can I do on the Free plan?',
    faq4A: 'Free gives you a single user, $5 of agent credit per month, and access to the lowest-tier machine. Team invites and higher-tier machines are unlocked starting on Starter. Concurrent agent runs are unlimited on every plan, Free included.',
    faq5Q: 'What happens if I run out of credit?',
    faq5A: "Agent runs pause until the next cycle or until you top up. We never auto-charge overages — you'll see usage in-app long before you hit zero, and you can upgrade or add credit with one click.",
    faq6Q: 'Which coding agents do you support?',
    faq6A: 'All of them. Each RunHQ workspace runs on its own VPS, so anything that works on Linux — Claude Code, Codex, Cursor CLI, Aider, custom scripts — runs out of the box. You bring your own Claude or Codex subscription; RunHQ never sits between you and the model provider.',
    // CTA
    ctaH: 'Pick a plan. Get the loop running today.',
    ctaPrimary: 'Get started →',
    ctaSecondary: 'Talk to sales',
    ctaMeta: 'Switch plans anytime · Cancel from Settings',
  },
  ko: {
    eyebrow: '가격 · 예측 가능한 플랫폼 + 사용자당 요금',
    h1: '팀에 맞춰 확장되는 예측 가능한 가격.',
    lede: '플랫폼 정액 요금 + 사용자당 요금 — 깜짝 청구도, 사용량 절벽도 없습니다. 읽기 전용 리뷰어는 언제나 무료입니다.',
    billingMonthly: '월간',
    billingAnnual: '연간',
    billingSave: '25% 절약',
    mostPopular: '가장 인기',
    unitMo: '/월',
    custom: '맞춤',
    freeSeat: '1명 · 초대 불가',
    seatSuffix: '/사용자',
    freeForever: '평생 무료',
    billedAnnually: '연간 결제',
    billedMonthly: '월간 결제',
    pricedToVolume: '사용량 기반 가격',
    // Plans
    planFreeName: '무료',
    planFreeTag: '가볍게 시작',
    planFreePitch: '1명, 최하위 머신, 월 $5 크레딧. 팀원을 초대하려면 업그레이드하세요.',
    planFreeCta: '무료로 시작',
    planFreeH1: '월 $5 agent 크레딧',
    planFreeH2: '1명 · 초대 불가',
    planFreeH3: '최하위 머신만',
    planFreeH4: '무제한 동시 실행',
    planStarterName: '스타터',
    planStarterTag: '새 팀에 적합',
    planStarterPitch: '어떤 코딩 agent로도 피드백을 라우팅. 전체 팀을 초대하고 머신 등급을 자유롭게 선택하세요.',
    planStarterCta: '시작하기',
    planStarterH1: '무료 플랜의 모든 기능, 그리고:',
    planStarterH2: '월 $75 agent 크레딧',
    planStarterH3: '모든 머신 등급',
    planStarterH4: '내부 피드백 위젯 (팀원용)',
    planProName: '프로',
    planProTag: '출시 중인 팀에 적합',
    planProPitch: '외부 사용자용 위젯, 그래프 기반 agent 플로우, 더 많은 크레딧.',
    planProCta: '시작하기',
    planProH1: '스타터의 모든 기능, 그리고:',
    planProH2: '월 $200 agent 크레딧',
    planProH3: '외부 사용자용 위젯',
    planProH4: '그래프 기반 agent 플로우',
    planEnterpriseName: '엔터프라이즈',
    planEnterpriseTag: '규제가 있는 조직에 적합',
    planEnterprisePitch: '싱글 테넌트 배포, 맞춤 DPA, 전담 담당자.',
    planEnterpriseCta: '문의하기',
    planEnterpriseH1: '프로의 모든 기능, 그리고:',
    planEnterpriseH2: '싱글 테넌트 배포',
    planEnterpriseH3: '맞춤 DPA + MSA',
    planEnterpriseH4: '전담 담당자',
    // Trust
    trustH: 'agent로 출시 중인 1,400+ 팀이 신뢰합니다',
    // Compare
    compareH: '모든 기능을 비교하세요.',
    compareSub: '네 가지 플랜을 항목별로 나란히.',
    secWorkspace: '워크스페이스',
    secAgents: 'agent & 크레딧',
    secGovernance: '거버넌스',
    rowUsers: '사용자',
    rowTeamInvites: '팀 초대',
    rowProjects: '프로젝트',
    rowReviewers: '리뷰어 (읽기 전용)',
    rowInternalWidget: '내부 위젯 (팀원용)',
    rowPublicWidget: '외부 사용자용 위젯',
    rowMonthlyCredit: '월 agent 크레딧',
    rowClaudeCode: 'Claude Code',
    rowCodex: 'Codex',
    rowBrowserTerm: '브라우저 + 터미널 실행',
    rowGraphFlow: '그래프 기반 agent 플로우',
    rowConcurrent: '동시 실행',
    rowMachineTiers: '머신 등급',
    rowProvenance: '프롬프트 + diff 출처 기록',
    rowCustomDPA: '맞춤 DPA',
    rowSingleTenant: '싱글 테넌트 배포',
    cellOne: '1',
    cellUnlimited: '무제한',
    cellNone: '없음',
    cellLowestOnly: '최하위만',
    cellAllTiers: '전체 등급',
    cellCustom: '맞춤',
    // Save callout
    saveWhy: '팀이 갈아타는 이유',
    saveH: '3개 도구를 1개로 — 연간 약 $14,000 절약',
    saveP: '평균적인 RunHQ 프로 고객은 피드백 위젯, agent 운영 대시보드, 티켓 분류 도구를 한꺼번에 정리합니다. 같은 루프, 하나의 청구서.',
    saveRow1T: '피드백 위젯',
    saveRow1V: '$8,400 / 년',
    saveRow2T: 'agent 대시보드',
    saveRow2V: '$7,800 / 년',
    saveRow3T: '티켓 분류 도구',
    saveRow3V: '$3,000 / 년',
    saveTotalT: 'RunHQ 프로, 연간 (8 사용자)',
    saveTotalV: '$4,800 / 년',
    // FAQ
    faqH: '자주 묻는 질문.',
    faq1Q: '사용자당 가격은 어떻게 작동하나요?',
    faq1A: '매월 플랫폼 정액 요금에 더해, 편집 권한이 있는 팀원 1인당 사용자 요금이 부과됩니다. 디자이너, 지원팀, 대표 등 읽기 전용 리뷰어는 모든 플랜에서 언제나 무료입니다.',
    faq2Q: '사용자(seat)와 리뷰어는 어떻게 다른가요?',
    faq2A: '사용자는 agent를 띄우고 작업을 출시합니다. 리뷰어는 댓글, 투표, 관전만 하며 — 모든 플랜에서 무제한 무료, 읽기 전용입니다. 대부분의 팀은 사용자 수보다 리뷰어가 3-4배 많습니다.',
    faq3Q: '월 agent 크레딧은 어떻게 작동하나요?',
    faq3A: '모든 플랜은 청구 주기마다 초기화되는 agent 크레딧을 포함합니다 — 무료는 $5, 스타터는 $75, 프로는 $200. 크레딧은 지원되는 모든 코딩 agent의 토큰 비용에 사용됩니다. 미사용 크레딧은 이월되지 않습니다.',
    faq4Q: '무료 플랜에서는 무엇을 할 수 있나요?',
    faq4A: '무료 플랜은 사용자 1명, 월 $5 agent 크레딧, 최하위 머신 접근을 제공합니다. 팀 초대와 상위 머신 등급은 스타터부터 열립니다. 동시 agent 실행은 무료 플랜을 포함한 모든 플랜에서 무제한입니다.',
    faq5Q: '크레딧이 다 떨어지면 어떻게 되나요?',
    faq5A: '다음 주기가 되거나 크레딧을 충전할 때까지 agent 실행이 일시정지됩니다. 초과분을 자동 청구하지 않습니다 — 크레딧이 0이 되기 한참 전부터 앱에서 사용량을 확인할 수 있고, 클릭 한 번으로 업그레이드하거나 충전할 수 있습니다.',
    faq6Q: '어떤 코딩 agent를 지원하나요?',
    faq6A: '전부 다 지원합니다. 각 RunHQ 워크스페이스는 자체 VPS에서 돌아가므로 Linux에서 동작하는 것은 무엇이든 — Claude Code, Codex, Cursor CLI, Aider, 커스텀 스크립트 — 그대로 실행됩니다. Claude나 Codex 구독은 직접 가져오시면 되고, RunHQ는 사용자와 모델 제공자 사이에 끼어들지 않습니다.',
    // CTA
    ctaH: '플랜을 고르세요. 오늘 바로 루프를 돌리세요.',
    ctaPrimary: '시작하기 →',
    ctaSecondary: '영업팀과 상담',
    ctaMeta: '플랜 변경은 언제든 가능 · 설정에서 취소',
  },
} as const;

const CompareCell = ({ v }: { v: Cell }) => {
  if (v === true) return <span className="rhpx-yes">✓</span>;
  if (v === false) return <span className="rhpx-no">—</span>;
  return <span className="rhpx-text">{v}</span>;
};

export default function PricingPage() {
  const t = useT(PRICING_T);
  const [billing, setBilling] = useState<'monthly' | 'annual'>('annual');

  const PLANS: Plan[] = [
    {
      key: 'free', name: t.planFreeName, tag: t.planFreeTag,
      monthly: 0, annual: 0, unit: t.unitMo, seat: null,
      pitch: t.planFreePitch,
      cta: t.planFreeCta, ghost: false,
      highlights: [
        t.planFreeH1,
        t.planFreeH2,
        t.planFreeH3,
        t.planFreeH4,
      ],
    },
    {
      key: 'starter', name: t.planStarterName, tag: t.planStarterTag,
      monthly: 100, annual: 75, unit: t.unitMo, seat: 15,
      pitch: t.planStarterPitch,
      cta: t.planStarterCta, ghost: false,
      highlights: [
        t.planStarterH1,
        t.planStarterH2,
        t.planStarterH3,
        t.planStarterH4,
      ],
    },
    {
      key: 'pro', name: t.planProName, tag: t.planProTag,
      monthly: 250, annual: 200, unit: t.unitMo, seat: 25,
      pitch: t.planProPitch,
      cta: t.planProCta, ghost: false, popular: true,
      highlights: [
        t.planProH1,
        t.planProH2,
        t.planProH3,
        t.planProH4,
      ],
    },
    {
      key: 'enterprise', name: t.planEnterpriseName, tag: t.planEnterpriseTag,
      monthly: null, annual: null, unit: '', seat: null,
      pitch: t.planEnterprisePitch,
      cta: t.planEnterpriseCta, ghost: true,
      highlights: [
        t.planEnterpriseH1,
        t.planEnterpriseH2,
        t.planEnterpriseH3,
        t.planEnterpriseH4,
      ],
    },
  ];

  const COMPARE: { sec: string; rows: [string, Cell, Cell, Cell, Cell][] }[] = [
    { sec: t.secWorkspace, rows: [
      [t.rowUsers,           t.cellOne,         t.cellUnlimited,    t.cellUnlimited,    t.cellUnlimited],
      [t.rowTeamInvites,     false,             true,               true,               true],
      [t.rowProjects,        t.cellOne,         t.cellUnlimited,    t.cellUnlimited,    t.cellUnlimited],
      [t.rowReviewers,       t.cellNone,        t.cellUnlimited,    t.cellUnlimited,    t.cellUnlimited],
      [t.rowInternalWidget,  false,             true,               true,               true],
      [t.rowPublicWidget,    false,             false,              true,               true],
    ]},
    { sec: t.secAgents, rows: [
      [t.rowMonthlyCredit,   '$5',              '$75',              '$200',             t.cellCustom],
      [t.rowClaudeCode,      true,              true,               true,               true],
      [t.rowCodex,           true,              true,               true,               true],
      [t.rowBrowserTerm,     true,              true,               true,               true],
      [t.rowGraphFlow,       false,             false,              true,               true],
      [t.rowConcurrent,      t.cellUnlimited,   t.cellUnlimited,    t.cellUnlimited,    t.cellUnlimited],
      [t.rowMachineTiers,    t.cellLowestOnly,  t.cellAllTiers,     t.cellAllTiers,     t.cellAllTiers],
    ]},
    { sec: t.secGovernance, rows: [
      [t.rowProvenance,      true,              true,               true,               true],
      [t.rowCustomDPA,       false,             false,              false,              true],
      [t.rowSingleTenant,    false,             false,              false,              true],
    ]},
  ];

  const FAQ = [
    { q: t.faq1Q, a: t.faq1A },
    { q: t.faq2Q, a: t.faq2A },
    { q: t.faq3Q, a: t.faq3A },
    { q: t.faq4Q, a: t.faq4A },
    { q: t.faq5Q, a: t.faq5A },
    { q: t.faq6Q, a: t.faq6A },
  ];

  const SAVE_ROWS = [
    { t: t.saveRow1T, v: t.saveRow1V },
    { t: t.saveRow2T, v: t.saveRow2V },
    { t: t.saveRow3T, v: t.saveRow3V },
  ];

  return (
    <div className="rhp-root rhpx-root">
      <style>{PRICING_STYLES}</style>
      <Navbar active="pricing" />

      <section className="rhp-hero">
        <div className="rhp-hero-eyebrow">{t.eyebrow}</div>
        <h1 className="rhp-hero-h1">{t.h1}</h1>
        <p className="rhp-hero-lede">
          {t.lede}
        </p>

        <div className="rhpx-toggle">
          <button
            type="button"
            className={`rhpx-toggle-btn ${billing === 'monthly' ? 'rhpx-toggle-on' : ''}`}
            onClick={() => setBilling('monthly')}
          >{t.billingMonthly}</button>
          <button
            type="button"
            className={`rhpx-toggle-btn ${billing === 'annual' ? 'rhpx-toggle-on' : ''}`}
            onClick={() => setBilling('annual')}
          >{t.billingAnnual} <span className="rhpx-toggle-pill">{t.billingSave}</span></button>
        </div>
      </section>

      {/* PLAN CARDS */}
      <section className="rhpx-plans">
        {PLANS.map((p) => {
          const price = billing === 'monthly' ? p.monthly : p.annual;
          const showPrice = price !== null;
          return (
            <div key={p.key} className={`rhpx-plan ${p.popular ? 'rhpx-plan-pop' : ''}`}>
              {p.popular && <div className="rhpx-plan-flag">{t.mostPopular}</div>}
              <div className="rhpx-plan-name">{p.name}</div>
              <div className="rhpx-plan-tag">{p.tag}</div>

              <div className="rhpx-plan-price">
                {showPrice ? (
                  <>
                    <span className="rhpx-plan-cur">$</span>
                    <span className="rhpx-plan-num">{price}</span>
                    <span className="rhpx-plan-unit">{p.unit}</span>
                  </>
                ) : (
                  <span className="rhpx-plan-custom">{t.custom}</span>
                )}
              </div>
              <div className="rhpx-plan-seat">
                {p.key === 'free'
                  ? t.freeSeat
                  : showPrice && p.seat !== null ? `+ $${p.seat}${t.seatSuffix}` : ' '}
              </div>
              {p.key === 'free' && <div className="rhpx-plan-billed">{t.freeForever}</div>}
              {showPrice && p.key !== 'free' && billing === 'annual' && (
                <div className="rhpx-plan-billed">{t.billedAnnually}</div>
              )}
              {showPrice && p.key !== 'free' && billing === 'monthly' && (
                <div className="rhpx-plan-billed">{t.billedMonthly}</div>
              )}
              {!showPrice && <div className="rhpx-plan-billed">{t.pricedToVolume}</div>}

              <a
                className={p.ghost ? 'rhpx-plan-cta rhpx-plan-cta-ghost' : 'rhpx-plan-cta rhpx-plan-cta-fill'}
                href={SIGNUP_URL}
              >{p.cta} →</a>

              <p className="rhpx-plan-pitch">{p.pitch}</p>

              <ul className="rhpx-plan-feats">
                {p.highlights.map((h, i) => (
                  <li key={i}>
                    <span className="rhpx-plan-check">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* TRUSTED BY */}
      <section className="rhpx-trust">
        <div className="rhpx-trust-h">{t.trustH}</div>
        <div className="rhpx-trust-row">
          {LOGOS.map((name) => <Wordmark key={name} name={name} size={18} color="var(--rhw-ink-mute)" />)}
        </div>
      </section>

      {/* COMPARE */}
      <section className="rhpx-compare">
        <h2 className="rhpx-compare-h">{t.compareH}</h2>
        <p className="rhpx-compare-sub">{t.compareSub}</p>

        <div className="rhpx-compare-wrap">
          <table className="rhpx-table">
            <thead>
              <tr>
                <th></th>
                {PLANS.map((p) => (
                  <th key={p.key} className={p.popular ? 'rhpx-th-pop' : ''}>
                    <div className="rhpx-th-name">{p.name}</div>
                    <div className="rhpx-th-price">
                      {p.monthly === null
                        ? t.custom
                        : p.seat === null
                          ? `$${billing === 'annual' ? p.annual : p.monthly}${p.unit}`
                          : `$${billing === 'annual' ? p.annual : p.monthly}${p.unit} + $${p.seat}${t.seatSuffix}`}
                    </div>
                    <a
                      className={p.ghost ? 'rhpx-th-cta rhpx-plan-cta-ghost' : 'rhpx-th-cta rhpx-plan-cta-fill'}
                      href={SIGNUP_URL}
                    >{p.cta}</a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((s) => (
                <Fragment key={s.sec}>
                  <tr className="rhpx-sec-row"><td colSpan={5}>{s.sec}</td></tr>
                  {s.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="rhpx-row-h">{r[0]}</td>
                      <td><CompareCell v={r[1]} /></td>
                      <td className="rhpx-td-pop"><CompareCell v={r[2]} /></td>
                      <td><CompareCell v={r[3]} /></td>
                      <td><CompareCell v={r[4]} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* SAVE CALLOUT */}
      <section className="rhpx-save">
        <div className="rhpx-save-card">
          <div className="rhpx-save-l">
            <div className="rhpx-save-pill">{t.saveWhy}</div>
            <h3 className="rhpx-save-h">{t.saveH}</h3>
            <p className="rhpx-save-p">
              {t.saveP}
            </p>
          </div>
          <div className="rhpx-save-r">
            {SAVE_ROWS.map((r) => (
              <div key={r.t} className="rhpx-save-row">
                <span className="rhpx-save-strike">{r.t}</span>
                <span className="rhpx-save-val">{r.v}</span>
              </div>
            ))}
            <div className="rhpx-save-total">
              <span>{t.saveTotalT}</span>
              <span className="rhpx-save-total-v">{t.saveTotalV}</span>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="rhpx-faq">
        <h2 className="rhpx-compare-h">{t.faqH}</h2>
        <div className="rhpx-faq-list">
          {FAQ.map((f, i) => (
            <details key={i} className="rhpx-faq-item">
              <summary className="rhpx-faq-q">
                <span>{f.q}</span>
                <span className="rhpx-faq-chev">+</span>
              </summary>
              <p className="rhpx-faq-a">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="rhpx-cta">
        <h2 className="rhpx-cta-h">{t.ctaH}</h2>
        <div className="rhpx-cta-row">
          <a className="rhp-btn-primary" href={SIGNUP_URL}>{t.ctaPrimary}</a>
          <a className="rhp-btn-ghost" href={SIGNUP_URL}>{t.ctaSecondary}</a>
        </div>
        <div className="rhpx-cta-meta">{t.ctaMeta}</div>
      </section>

      <Footer />
    </div>
  );
}

const PRICING_STYLES = `
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
    max-width: 680px;
    margin: 0 auto;
    text-wrap: pretty;
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

  .rhpx-toggle {
    display: inline-flex; gap: 4px;
    padding: 4px;
    background: var(--rhw-bg-2);
    border: 1px solid var(--rhw-line);
    border-radius: 11px;
    margin-top: 28px;
  }
  .rhpx-toggle-btn {
    padding: 8px 16px;
    border: 0; background: transparent;
    border-radius: 8px;
    font: inherit; font-size: 13.5px; font-weight: 500;
    color: var(--rhw-ink-soft);
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .rhpx-toggle-on { background: var(--rhw-ink); color: #fff; }
  .rhpx-toggle-pill {
    font-size: 10.5px; padding: 2px 7px;
    background: oklch(0.75 0.18 145);
    color: #07271a;
    border-radius: 999px;
    font-weight: 600;
  }

  .rhpx-plans {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    padding: 32px 48px 64px;
    max-width: 1320px; margin: 0 auto;
  }
  .rhpx-plan {
    position: relative;
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 16px;
    padding: 28px 24px;
    display: flex; flex-direction: column;
  }
  .rhpx-plan-pop {
    border: 2px solid var(--rhw-ink);
    box-shadow: 0 30px 60px -30px rgba(20, 19, 15, 0.18);
  }
  .rhpx-plan-flag {
    position: absolute; top: -12px; left: 24px;
    padding: 4px 10px;
    background: var(--rhw-ink);
    color: #fff;
    border-radius: 999px;
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.04em;
  }
  .rhpx-plan-name { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .rhpx-plan-tag { font-size: 12.5px; color: var(--rhw-ink-mute); margin: 4px 0 22px; }
  .rhpx-plan-price { display: flex; align-items: baseline; gap: 4px; }
  .rhpx-plan-cur { font-size: 22px; color: var(--rhw-ink-soft); }
  .rhpx-plan-num { font-size: 48px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
  .rhpx-plan-unit { font-size: 13px; color: var(--rhw-ink-mute); margin-left: 4px; }
  .rhpx-plan-custom { font-size: 36px; font-weight: 600; letter-spacing: -0.03em; }
  .rhpx-plan-seat { font-size: 13.5px; color: var(--rhw-ink-soft); margin-top: 8px; font-weight: 500; min-height: 18px; }
  .rhpx-plan-billed { font-size: 11.5px; color: var(--rhw-ink-mute); margin-top: 4px; min-height: 16px; }
  .rhpx-plan-cta {
    margin: 18px 0 16px;
    padding: 11px 16px;
    border-radius: 9px;
    font-size: 13.5px; font-weight: 500;
    text-align: center;
    cursor: pointer;
    display: block;
  }
  .rhpx-plan-cta-fill {
    background: var(--rhw-ink);
    color: #fff !important;
    border: 1px solid var(--rhw-ink);
  }
  .rhpx-plan-cta-fill:hover { background: var(--rhw-accent); border-color: var(--rhw-accent); }
  .rhpx-plan-cta-ghost {
    background: var(--rhw-surface);
    color: var(--rhw-ink) !important;
    border: 1px solid var(--rhw-line);
  }
  .rhpx-plan-cta-ghost:hover { border-color: var(--rhw-ink); }
  .rhpx-plan-pitch { font-size: 13px; line-height: 1.5; color: var(--rhw-ink-soft); margin: 0 0 18px; min-height: 56px; }
  .rhpx-plan-feats {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 10px;
    padding-top: 18px;
    border-top: 1px solid var(--rhw-line-soft);
  }
  .rhpx-plan-feats li {
    display: flex; gap: 9px;
    font-size: 13.5px; line-height: 1.45;
    color: var(--rhw-ink);
  }
  .rhpx-plan-check { color: var(--rhw-good); font-weight: 700; flex-shrink: 0; }

  .rhpx-trust {
    padding: 24px 48px 56px;
    max-width: 1300px; margin: 0 auto;
    text-align: center;
    border-top: 1px solid var(--rhw-line-soft);
  }
  .rhpx-trust-h {
    font-size: 12px; letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    margin-bottom: 22px;
  }
  .rhpx-trust-row {
    display: flex; flex-wrap: wrap;
    justify-content: center;
    gap: 32px 40px;
    opacity: 0.85;
  }

  .rhpx-compare { padding: 64px 48px; max-width: 1300px; margin: 0 auto; }
  .rhpx-compare-h { font-size: 36px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 8px; text-align: center; }
  .rhpx-compare-sub { color: var(--rhw-ink-mute); text-align: center; margin: 0 0 32px; }
  .rhpx-compare-wrap {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 14px;
    overflow: hidden;
    overflow-x: auto;
  }
  .rhpx-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .rhpx-table th, .rhpx-table td {
    padding: 14px 16px;
    text-align: center;
    border-bottom: 1px solid var(--rhw-line-soft);
    vertical-align: middle;
  }
  .rhpx-table thead th {
    background: var(--rhw-bg-2);
    padding: 22px 16px;
    border-bottom: 1px solid var(--rhw-line);
  }
  .rhpx-th-pop { background: var(--rhw-ink) !important; color: #fff; }
  .rhpx-th-pop .rhpx-th-cta.rhpx-plan-cta-fill { background: #fff; color: var(--rhw-ink) !important; border-color: #fff; }
  .rhpx-th-name { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .rhpx-th-price { font-size: 12px; color: var(--rhw-ink-mute); margin-bottom: 12px; }
  .rhpx-th-pop .rhpx-th-price { color: rgba(255,255,255,0.65); }
  .rhpx-th-cta {
    padding: 7px 12px;
    border-radius: 7px;
    font-size: 12px; font-weight: 500;
    cursor: pointer;
    display: inline-block;
  }
  .rhpx-row-h { text-align: left !important; font-weight: 500; color: var(--rhw-ink); }
  .rhpx-sec-row td {
    background: var(--rhw-bg) !important;
    padding: 16px 16px 8px !important;
    text-align: left !important;
    font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rhw-ink-mute);
    border-bottom: 1px solid var(--rhw-line);
  }
  .rhpx-yes { color: var(--rhw-good); font-weight: 700; }
  .rhpx-no { color: var(--rhw-ink-faint); }
  .rhpx-text { font-size: 13px; color: var(--rhw-ink-soft); }
  .rhpx-td-pop { background: rgba(20,19,15,0.025); }

  .rhpx-save { padding: 32px 48px 64px; max-width: 1300px; margin: 0 auto; }
  .rhpx-save-card {
    background: var(--rhw-ink); color: #fff;
    border-radius: 18px;
    padding: 48px;
    display: grid; grid-template-columns: 1.2fr 1fr;
    gap: 56px; align-items: center;
  }
  .rhpx-save-pill {
    display: inline-block;
    padding: 4px 11px;
    background: rgba(255,255,255,0.12);
    border-radius: 999px;
    font-size: 11px; letter-spacing: 0.06em;
    margin-bottom: 16px;
  }
  .rhpx-save-h { font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; margin: 0 0 14px; }
  .rhpx-save-p { color: rgba(255,255,255,0.7); margin: 0; line-height: 1.55; }
  .rhpx-save-r { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 18px 20px; }
  .rhpx-save-row {
    display: flex; justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    font-size: 13.5px;
  }
  .rhpx-save-strike { text-decoration: line-through; color: rgba(255,255,255,0.5); }
  .rhpx-save-val { color: rgba(255,255,255,0.5); }
  .rhpx-save-total {
    display: flex; justify-content: space-between;
    padding: 14px 0 4px;
    font-size: 14.5px; font-weight: 500;
  }
  .rhpx-save-total-v { color: oklch(0.85 0.18 145); font-weight: 600; }

  .rhpx-faq { padding: 64px 48px; max-width: 920px; margin: 0 auto; }
  .rhpx-faq-list { display: flex; flex-direction: column; gap: 4px; margin-top: 28px; }
  .rhpx-faq-item {
    background: var(--rhw-surface);
    border: 1px solid var(--rhw-line);
    border-radius: 12px;
  }
  .rhpx-faq-item[open] { border-color: var(--rhw-ink); }
  .rhpx-faq-q {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 22px;
    cursor: pointer;
    font-size: 15px; font-weight: 500;
    list-style: none;
  }
  .rhpx-faq-q::-webkit-details-marker { display: none; }
  .rhpx-faq-chev { font-size: 20px; color: var(--rhw-ink-mute); font-weight: 300; transition: transform 0.2s; }
  .rhpx-faq-item[open] .rhpx-faq-chev { transform: rotate(45deg); }
  .rhpx-faq-a { padding: 0 22px 20px; margin: 0; color: var(--rhw-ink-soft); line-height: 1.6; font-size: 14px; }

  .rhpx-cta { padding: 56px 48px 80px; text-align: center; max-width: 800px; margin: 0 auto; }
  .rhpx-cta-h { font-size: 38px; letter-spacing: -0.028em; font-weight: 600; margin: 0 0 24px; text-wrap: balance; }
  .rhpx-cta-row { display: inline-flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  .rhpx-cta-meta { font-size: 12.5px; color: var(--rhw-ink-mute); margin-top: 16px; }

  @media (max-width: 1100px) {
    .rhpx-plans { grid-template-columns: repeat(2, 1fr); }
    .rhpx-save-card { grid-template-columns: 1fr; gap: 32px; padding: 32px; }
  }
  @media (max-width: 720px) {
    .rhpx-plans { grid-template-columns: 1fr; padding: 20px 24px 48px; }
    .rhp-hero { padding: 56px 24px 24px; }
    .rhp-hero-h1 { font-size: 38px; }
    .rhpx-compare { padding: 48px 16px; }
    .rhpx-faq, .rhpx-cta { padding-left: 24px; padding-right: 24px; }
    .rhpx-save { padding: 24px 24px 48px; }
  }
`;
