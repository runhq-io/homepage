import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HomeNav, HomeFooter, HOME_CHROME_STYLES, SHOWCASE_BOARD_URL } from '../components/homeChrome';
import { LOGOS } from '../components/chrome';
import { useT } from '../i18n/context';
import '../components/rq-blob.js';

/**
 * Homepage, ported from the "RunHQ Homepage v10" design: a giant wordmark hero
 * over the pixel blob, a looping "generations" demo of variants being built,
 * measured and pruned, and a closing line whose verbs swap places.
 *
 * Copy rules from the design brief: no em dashes, keep it minimal, and the
 * product is live (no "Request access").
 */
const HOME_T = {
  en: {
    work: 'Work',
    customersH: 'Companies evolving on RunHQ',
    heroA: 'Make your company ',
    heroB: 'self‑evolve.',
    evoA: 'Evolution, ',
    evoB: 'automated.',
    evoDeck: 'RunHQ collects analytics, builds variations, and lets the best survive.',
    generation: 'Generation',
    goalA: 'Goal',
    goalB: 'conversion',
    // Closing line. Frame 0 reads "Build a company that runs itself.",
    // frame 1 "Run a company that builds itself."
    close1: { pre: '', words: ['Build', 'Run'], post: 'a company' },
    close2: { pre: 'that', words: ['runs', 'builds'], post: 'itself.' },
    variants: [
      'One-page checkout', 'Guest checkout', 'Wallet pay first', 'Saved cards', 'Shorter form',
      'One-page, autofill', 'One-page, wallet', 'Wallet, one tap', 'Wallet, coupon',
      'Address lookup', 'Autofill everything', 'Trust badges', 'Remember cards',
      'Predictive address', 'Fewer fields', 'Instant receipt', 'Remembered device',
    ],
  },
  ko: {
    work: '사례',
    customersH: 'RunHQ로 진화하는 회사들',
    heroA: '회사가 스스로 ',
    heroB: '진화하도록.',
    evoA: '진화, ',
    evoB: '자동으로.',
    evoDeck: 'RunHQ가 데이터를 모으고, 변형을 만들고, 가장 좋은 것만 남깁니다.',
    generation: '세대',
    goalA: '목표 전환율',
    goalB: '',
    // 0: "스스로 운영되는 회사를 만드세요."  1: "스스로 만들어지는 회사를 운영하세요."
    close1: { pre: '스스로', words: ['운영되는', '만들어지는'], post: '' },
    close2: { pre: '회사를', words: ['만드세요.', '운영하세요.'], post: '' },
    variants: [
      '한 페이지 결제', '비회원 결제', '간편결제 우선', '저장된 카드', '짧은 양식',
      '한 페이지, 자동 입력', '한 페이지, 간편결제', '간편결제, 원탭', '간편결제, 쿠폰',
      '주소 검색', '모두 자동 입력', '신뢰 배지', '카드 기억하기',
      '주소 예측', '입력 항목 축소', '즉시 영수증', '기기 기억하기',
    ],
  },
} as const;

/* ------------------------------------------------------------------------ */
/* Generations demo                                                          */
/* ------------------------------------------------------------------------ */

type Phase = 'pre' | 'spawn' | 'grow' | 'judge' | 'prune' | 'promote' | 'reset';

const PHASE_MS: Record<Phase, number> = {
  pre: 400, spawn: 1000, grow: 3000, judge: 1500, prune: 900, promote: 1200, reset: 900,
};

// pre, then spawn..promote for each of 4 generations, then reset.
const SEQUENCE: [number, Phase][] = (() => {
  const seq: [number, Phase][] = [[0, 'pre']];
  for (let g = 0; g < 4; g++) {
    (['spawn', 'grow', 'judge', 'prune', 'promote'] as Phase[]).forEach((p) => seq.push([g, p]));
  }
  seq.push([3, 'reset']);
  return seq;
})();

// Goal conversion per generation.
const TARGETS = [52, 60, 67, 73];

// [generation, score, lineage, kept, index within its group]
const VARIANTS = (
  [
    [0, 61, 0, 1, 0], [0, 48, -1, 0, 1], [0, 57, 1, 1, 2], [0, 44, -1, 0, 3], [0, 50, -1, 0, 4],
    [1, 58, 0, 0, 0], [1, 66, 0, 1, 1], [1, 63, 1, 1, 0], [1, 55, 1, 0, 1],
    [2, 64, 0, 0, 0], [2, 71, 0, 1, 1], [2, 62, 1, 0, 0], [2, 69, 1, 1, 1],
    [3, 76, 0, 1, 0], [3, 70, 0, 0, 1], [3, 68, 1, 0, 0], [3, 78, 1, 1, 1],
  ] as const
).map(([g, s, lin, k, i], n) => ({ n, g, s, lin, k: !!k, i }));

const ROW_H = 64;
const EASE = 'cubic-bezier(.65,0,.35,1)';
const pos = (v: number) => `${(((v - 30) / 60) * 100).toFixed(1)}%`;

// Visitors who ask for reduced motion get one still frame of each animation.
function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

// The still frame: the last generation judged, with kept and pruned variants.
const STILL_STEP = SEQUENCE.findIndex(([g, p]) => g === 3 && p === 'judge');

function useGenerations() {
  const reduce = usePrefersReducedMotion();
  const [playStep, setStep] = useState(0);
  const [, setTick] = useState(0);
  const growT0 = useRef(0);
  const step = reduce ? STILL_STEP : playStep;
  const [gi, gp] = SEQUENCE[step];

  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % SEQUENCE.length), PHASE_MS[gp]);
    if (gp !== 'grow') return () => clearTimeout(t);
    growT0.current = performance.now();
    let raf = 0;
    const tick = () => {
      setTick(performance.now());
      if (performance.now() - growT0.current < 2900) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [reduce, step, gp]);

  const judged = gp === 'judge' || gp === 'prune' || gp === 'promote';
  const childRow = (v: (typeof VARIANTS)[number]) => (v.g === 0 ? v.i : v.lin * 3 + 1 + v.i);

  const rows = VARIANTS.map((v) => {
    let vis = false, row = 0, pad = 0, w = 0, bg = '#6d6c66', val = '', strike = 'none', op = 0;
    let btr = 'width .6s ease, background .5s';
    if (v.g === gi) {
      vis = gp !== 'pre' && gp !== 'reset' && !((gp === 'prune' || gp === 'promote') && !v.k);
      const promoted = gp === 'promote' && v.k;
      row = promoted ? v.lin * 3 : gp === 'pre' ? (v.g === 0 ? v.i : v.lin * 3) : childRow(v);
      if (gp === 'reset' && v.k) row = v.lin * 3;
      pad = gi > 0 && !promoted && gp !== 'reset' ? 28 : 0;
      w = gp === 'pre' || gp === 'spawn' ? 0 : v.s;
      if (gp === 'grow') {
        const el = (performance.now() - growT0.current) / 1000;
        const p = Math.max(0, Math.min(1, (el - (v.g === 0 ? v.i : v.lin * 2 + v.i) * 0.16) / 2.4));
        const e = 1 - Math.pow(1 - p, 3);
        w = p > 0 ? 30 + (v.s - 30) * e : 0;
        val = p > 0 ? `${Math.round(30 + (v.s - 30) * e)}%` : '';
        btr = 'none';
      }
      if (judged) {
        bg = v.k ? '#141412' : '#b9b7af';
        val = `${v.s}%`;
        strike = v.k ? 'none' : 'line-through';
      }
      op = vis ? (judged && !v.k ? 0.45 : 1) : 0;
    } else if (v.g === gi - 1 && v.k) {
      // Last generation's survivors stay on screen as parents while children grow.
      vis = gp === 'spawn' || gp === 'grow' || gp === 'judge';
      row = v.lin * 3; w = v.s; bg = '#8d8b84'; val = `${v.s}%`;
      op = vis ? (gp === 'judge' ? 0.5 : 1) : 0;
    } else if (v.g > gi) {
      row = v.g === 0 ? v.i : v.lin * 3; pad = v.g > 0 ? 28 : 0;
    } else {
      row = v.k ? v.lin * 3 : childRow(v); w = v.s;
    }
    return {
      n: v.n, top: row * ROW_H, op, pad, w: w > 30 ? pos(w) : '0%', bg, btr, val, strike,
      tr: vis ? `top .9s ${EASE}, opacity .6s ease` : 'opacity .6s ease',
    };
  });

  return {
    rows,
    genNum: String(gi + 1).padStart(2, '0'),
    target: `${TARGETS[gi]}%`,
    tpos: pos(TARGETS[gi]),
    hdOp: gp === 'reset' || gp === 'pre' ? 0 : 1,
  };
}

function Generations() {
  const t = useT(HOME_T);
  const { rows, genNum, target, tpos, hdOp } = useGenerations();
  return (
    <div>
      <div className="rhn-gen-head">
        <span>{t.generation} <b style={{ opacity: hdOp }}>{genNum}</b></span>
      </div>
      <div className="rhn-gen-board" style={{ height: ROW_H * 6 }}>
        <div className="rhn-gen-grid rhn-gen-goal-layer">
          <span />
          <div style={{ position: 'relative' }}>
            <div className="rhn-gen-goal-line" style={{ left: tpos }} />
            <span className="rhn-gen-goal-label" style={{ left: tpos }}>
              {t.goalA} <b style={{ opacity: hdOp }}>{target}</b>{t.goalB && ` ${t.goalB}`}
            </span>
          </div>
          <span />
        </div>
        {rows.map((r) => (
          <div
            key={r.n}
            className="rhn-gen-grid rhn-gen-row"
            style={{ top: r.top, opacity: r.op, transition: r.tr }}
            aria-hidden={r.op === 0}
          >
            <span className="rhn-gen-name" style={{ paddingLeft: r.pad, textDecoration: r.strike }}>
              <span className="rhn-gen-arrow" style={{ opacity: r.pad ? 1 : 0 }}>↳</span>
              {t.variants[r.n]}
            </span>
            <div className="rhn-gen-track">
              <div style={{ width: r.w, background: r.bg, transition: r.btr }} />
            </div>
            <span className="rhn-gen-val">{r.val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Closing line: two words per line crossfade, the slot width animates       */
/* ------------------------------------------------------------------------ */

type SwapLine = { pre: string; words: readonly [string, string] | readonly string[]; post: string };

function SwapSlot({ words, frame, delay }: { words: readonly string[]; frame: number; delay: number }) {
  const refs = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [widths, setWidths] = useState<number[] | null>(null);

  useLayoutEffect(() => {
    const measure = () => setWidths(refs.map((r) => r.current?.getBoundingClientRect().width ?? 0));
    measure();
    document.fonts?.ready.then(measure);
    // Observe the words themselves: font loads and breakpoint font-size changes
    // resize them without necessarily lining up with a window resize event.
    const ro = new ResizeObserver(measure);
    refs.forEach((r) => r.current && ro.observe(r.current));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words]);

  const d = `${delay}s`;
  return (
    <span
      className="rhn-swap"
      style={{
        width: widths ? `${widths[frame]}px` : 'auto',
        transition: `width 1.6s ${EASE} ${d}`,
      }}
    >
      {words.slice(0, 2).map((w, i) => (
        <span
          key={w}
          ref={refs[i]}
          aria-hidden={i !== frame}
          style={{
            opacity: i === frame ? 1 : 0,
            filter: i === frame ? 'blur(0px)' : 'blur(10px)',
            transition: `opacity 1.4s ease ${d}, filter 1.4s ease ${d}`,
          }}
        >{w}</span>
      ))}
    </span>
  );
}

function Closing() {
  const t = useT(HOME_T);
  const reduce = usePrefersReducedMotion();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reduce) { setFrame(0); return; }
    const id = setInterval(() => setFrame((f) => (f ? 0 : 1)), 4800);
    return () => clearInterval(id);
  }, [reduce]);
  const line = (l: SwapLine, delay: number, className: string) => (
    <span className={className}>
      {l.pre && <span className="rhn-swap-pre">{l.pre}</span>}
      <SwapSlot words={l.words} frame={frame} delay={delay} />
      {l.post && <span className="rhn-swap-post">{l.post}</span>}
    </span>
  );
  return (
    <section className="rhn-close">
      <h2 className="rhn-close-h">
        {line(t.close1, 0, 'rhn-close-line')}
        {line(t.close2, 0.25, 'rhn-close-line rhn-close-line-b')}
      </h2>
    </section>
  );
}

/* ------------------------------------------------------------------------ */

function PixelBlob() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = document.createElement('rq-blob');
    el.setAttribute('zoom', '1');
    el.setAttribute('slow', '1.9');
    host.current?.appendChild(el);
    return () => el.remove();
  }, []);
  return <div ref={host} className="rhn-fx" aria-hidden="true" />;
}

export default function HomePage() {
  const t = useT(HOME_T);

  return (
    <div className="rhn-root">
      <style>{HOME_CHROME_STYLES + HOME_STYLES}</style>

      <div className="rhn-hero">
        <HomeNav source="home" />
        <div className="rhn-hero-copy">
          <h1 className="rhn-h1">{t.heroA}<em>{t.heroB}</em></h1>
        </div>
        <PixelBlob />
        <div className="rhn-hero-meta">
          <span />
          <a href={SHOWCASE_BOARD_URL}>{t.work} ↗</a>
        </div>
        <div className="rhn-wordmark" aria-label="RunHQ">RunHQ</div>
      </div>

      <section className="rhn-customers" aria-label={t.customersH}>
        <span className="rhn-customers-h">{t.customersH}</span>
        <ul className="rhn-customers-list">
          {LOGOS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      </section>

      <section className="rhn-evo">
        <div className="rhn-evo-inner">
          <div className="rhn-evo-head">
            <h2 className="rhn-h2">{t.evoA}<em>{t.evoB}</em></h2>
            <p className="rhn-deck">{t.evoDeck}</p>
          </div>
          <Generations />
        </div>
      </section>

      <Closing />

      <HomeFooter source="home" />
    </div>
  );
}

const HOME_STYLES = `
  /* HERO */
  .rhn-hero {
    height: 100vh; height: 100svh; min-height: 620px;
    display: flex; flex-direction: column;
    overflow: hidden; position: relative;
  }
  .rhn-hero-copy {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
    padding: 14vh var(--rhn-pad) 0;
    position: relative; z-index: 2;
  }
  .rhn-h1 {
    margin: 0;
    font: 400 clamp(56px, 7.4vw, 136px)/0.95 var(--rhn-serif);
    letter-spacing: -.03em; text-wrap: balance; text-align: center;
  }
  .rhn-fx {
    position: absolute; inset: 0; opacity: .2; pointer-events: none; z-index: 0;
  }
  .rhn-hero-meta {
    display: flex; justify-content: space-between; align-items: baseline;
    flex-wrap: wrap; gap: 12px 32px;
    padding: 0 var(--rhn-pad) 20px;
    font: 400 12px var(--rhn-mono); letter-spacing: .04em; color: var(--rhn-mute);
    position: relative; z-index: 2;
  }
  .rhn-wordmark {
    font: 500 clamp(160px, 27vw, 440px)/0.74 var(--rhn-sans);
    letter-spacing: -.075em;
    margin: 0 0 -0.02em -0.05em;
    white-space: nowrap; position: relative; z-index: 1;
    user-select: none;
  }

  /* CUSTOMERS */
  .rhn-customers {
    border-top: 1px solid #a9a79f;
    padding: 40px var(--rhn-pad);
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: 16px 48px;
  }
  .rhn-customers-h {
    font: 400 12px var(--rhn-mono); letter-spacing: .04em; color: var(--rhn-mute);
  }
  .rhn-customers-list {
    margin: 0; padding: 0; list-style: none;
    display: flex; flex-wrap: wrap; gap: 12px 56px;
  }
  .rhn-customers-list li {
    font: 500 clamp(20px, 2vw, 28px)/1 var(--rhn-sans);
    letter-spacing: -.03em; white-space: nowrap;
  }

  /* EVOLUTION */
  .rhn-evo {
    border-top: 1px solid #a9a79f;
    padding: 128px var(--rhn-pad);
    display: flex; justify-content: center;
  }
  .rhn-evo-inner { width: 100%; max-width: 960px; display: flex; flex-direction: column; gap: 56px; }
  .rhn-evo-head { display: flex; flex-direction: column; gap: 20px; }
  .rhn-h2 {
    margin: 0;
    font: 400 clamp(40px, 4.6vw, 64px)/1 var(--rhn-serif);
    letter-spacing: -.03em; white-space: nowrap;
  }
  .rhn-deck { margin: 0; font: 400 17px/1.55 var(--rhn-sans); color: var(--rhn-mute); text-wrap: pretty; }
  .rhn-gen-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 24px;
    padding-bottom: 20px;
    font: 400 15px/1.4 var(--rhn-sans); font-variant-numeric: tabular-nums;
  }
  .rhn-root b { font-weight: 500; transition: opacity .5s; }
  .rhn-gen-board { position: relative; border-top: 1px solid var(--rhn-ink); }
  .rhn-gen-grid {
    display: grid; grid-template-columns: minmax(0, 200px) minmax(0, 1fr) 56px; gap: 24px;
  }
  .rhn-gen-goal-layer { position: absolute; inset: 0; pointer-events: none; }
  .rhn-gen-goal-line {
    position: absolute; top: 0; bottom: 0;
    border-left: 1px dashed var(--rhn-ink);
    transition: left 1.1s ${EASE};
  }
  .rhn-gen-goal-label {
    position: absolute; bottom: 100%; transform: translateX(-50%);
    padding-bottom: 20px; white-space: nowrap;
    font: 400 15px/1.4 var(--rhn-sans); font-variant-numeric: tabular-nums;
    color: var(--rhn-mute);
    transition: left 1.1s ${EASE};
  }
  .rhn-gen-goal-label b { color: var(--rhn-ink); }
  .rhn-gen-row {
    position: absolute; left: 0; right: 0; height: ${ROW_H}px;
    align-items: center;
    border-bottom: 1px solid #b9b7af; box-sizing: border-box;
    font: 400 15px/1.4 var(--rhn-sans); font-variant-numeric: tabular-nums;
  }
  .rhn-gen-name {
    position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: padding-left .9s ${EASE};
  }
  .rhn-gen-arrow { position: absolute; left: 2px; top: 0; color: var(--rhn-mute); transition: opacity .6s; }
  .rhn-gen-track { position: relative; height: 6px; background: #c3c1ba; }
  .rhn-gen-track > div { position: absolute; left: 0; top: 0; bottom: 0; }
  .rhn-gen-val { text-align: right; }

  /* CLOSING */
  .rhn-close {
    background: var(--rhn-ink); color: #e8e6df;
    min-height: 80vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 120px var(--rhn-pad); text-align: center;
  }
  .rhn-close-h {
    margin: 0;
    font: 400 clamp(44px, 5.6vw, 92px)/1.02 var(--rhn-serif);
    letter-spacing: -.03em;
    display: flex; flex-direction: column; align-items: center;
  }
  .rhn-close-line { display: flex; align-items: baseline; white-space: nowrap; }
  .rhn-close-line-b { font-style: italic; color: #a8a69e; }
  .rhn-swap-pre { padding-right: .22em; }
  .rhn-swap-post { padding-left: .24em; }
  .rhn-swap { display: inline-grid; grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .rhn-swap > span { grid-area: 1 / 1; white-space: nowrap; }

  @media (max-width: 720px) {
    .rhn-h1 { font-size: clamp(44px, 12vw, 56px); }
    .rhn-wordmark { font-size: 34vw; }
    .rhn-customers { padding-top: 32px; padding-bottom: 32px; }
    .rhn-customers-list { gap: 10px 32px; }
    .rhn-evo { padding-top: 96px; padding-bottom: 96px; }
    .rhn-h2 { white-space: normal; }
    .rhn-gen-grid { grid-template-columns: minmax(0, 132px) minmax(0, 1fr) 44px; gap: 14px; }
    .rhn-gen-row, .rhn-gen-head, .rhn-gen-goal-label { font-size: 13px; }
    .rhn-close-h { font-size: clamp(30px, 9vw, 44px); }
  }
`;
