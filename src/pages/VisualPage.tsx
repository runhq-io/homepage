import { useEffect, useRef, useState } from 'react';
import { Navbar, Footer } from '../components/chrome';
import { useT, useLocale } from '../i18n/context';

/**
 * Visual: BEFORE vs AFTER pipelines as a 2D physics simulation.
 *
 * Model — kept deliberately small:
 *   • A Station is a circle in space. It has a slot count and a fixed processing time.
 *     Stations are PURELY attractors and processors. They are NOT physical obstacles.
 *   • A Particle is a 2D body (x, y, vx, vy) with a single target station id (and an
 *     `inProcess` flag while it sits in a slot).
 *   • One physics rule per frame:
 *       1. If a particle is free, accelerate it toward its target's slot.
 *       2. Resolve pairwise collision between every pair of particles
 *          (in-process particles are solid obstacles — others can't pass through them).
 *   • Stations look at the world after physics:
 *       - A pass-through router retargets any free particle inside its radius.
 *       - A real station, for each empty slot, claims the closest free particle whose
 *         target matches and that's within CLAIM_DISTANCE of the slot.
 *       - A slot whose timer has elapsed releases its particle: clears `inProcess`,
 *         changes `target` to the next station (round-robin among outputs).
 *
 * Pile-up is not programmed. It's the natural consequence of N particles all
 * gravitating toward the same slot while one in-process particle blocks the slot
 * and pairwise collisions keep them from overlapping.
 */

interface StationConfig {
  id: string;
  label: string;
  capacity: number;       // 0 = pass-through router; >0 = N parallel slots
  processingTime: number; // ms (constant — no randomization)
  pos: { x: number; y: number }; // normalized 0..1 in canvas space
  outputs: string[];      // round-robin among these next stations
}

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  target: string | null;  // station id this particle is gravitating toward; null = shipped
  inProcess: boolean;     // true while sitting in a slot (frozen, acts as a solid obstacle)
  transitioning: boolean; // true after a fresh retarget — uses direct velocity (not force) so it plows through any cluster in its way
  processingStart?: number;
  processingDuration?: number;
  slotStationId?: string;
  slotIdx?: number;
}

interface StationRuntime {
  config: StationConfig;
  slots: (Particle | null)[];
}

// ─── Tuning ─────────────────────────────────────────────────────────────────
const SPAWN_MS = 1000;        // 1 ticket per second from USER
const GRAVITY_F = 0.5;        // max attraction force toward target station (per frame)
const GRAVITY_RAMP = 0.02;    // force ramps as `min(GRAVITY_F, dist * GRAVITY_RAMP)` — weak near target so clusters settle instead of rotating
const DAMP = 0.88;
const SPAWN_Y_JITTER = 18;    // ±9px deterministic vertical spread at spawn so collisions have y-components
const TRANSITION_SPEED = 3;   // px/frame — direct velocity for a freshly-retargeted particle so it plows out of its old cluster
const TRANSITION_END_BUFFER = 16; // particle switches back to force-based gravity once within (target_radius + this) of the new target
const PR = 5;                 // particle radius
const NODE_RADIUS = 40;       // visual radius for real stations
const PASS_RADIUS = 22;       // visual radius for pass-through routers
const COLLISION_ITERS = 4;    // pairwise collision passes per frame
const CLAIM_DISTANCE = 18;    // distance from station center at which a particle is claimed

export const BEFORE_STATIONS: StationConfig[] = [
  { id: 'user',    label: 'USER FEEDBACK',    capacity: 0, processingTime: 0,    pos: { x: 0.06, y: 0.5 }, outputs: ['support'] },
  { id: 'support', label: 'SUPPORT',   capacity: 1, processingTime: 1568, pos: { x: 0.22, y: 0.5 }, outputs: ['mgmt'] },
  { id: 'mgmt',    label: 'MANAGER',   capacity: 1, processingTime: 2400, pos: { x: 0.37, y: 0.5 }, outputs: ['dev'] },
  { id: 'dev',     label: 'DEVELOPER (USING AI)', capacity: 1, processingTime: 3000, pos: { x: 0.54, y: 0.5 }, outputs: ['review'] },
  { id: 'review',  label: 'CODE REVIEW + QA', capacity: 1, processingTime: 800,  pos: { x: 0.74, y: 0.5 }, outputs: ['deploy'] },
  { id: 'deploy',  label: 'DEPLOY',           capacity: 1, processingTime: 1000, pos: { x: 0.94, y: 0.5 }, outputs: [] },
];

export const AFTER_STATIONS: StationConfig[] = [
  { id: 'user',    label: 'USER FEEDBACK',   capacity: 0, processingTime: 0,    pos: { x: 0.06, y: 0.5  }, outputs: ['widget'] },
  { id: 'widget',  label: 'RUNHQ', capacity: 1, processingTime: 500, pos: { x: 0.22, y: 0.5  }, outputs: ['agent_1', 'agent_2', 'agent_3'] },
  { id: 'agent_1', label: 'CODING AGENT', capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.22 }, outputs: ['review'] },
  { id: 'agent_2', label: 'CODING AGENT', capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.50 }, outputs: ['review'] },
  { id: 'agent_3', label: 'CODING AGENT', capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.78 }, outputs: ['review'] },
  { id: 'review',  label: 'CODE REVIEW + QA', capacity: 1, processingTime: 800, pos: { x: 0.70, y: 0.5 }, outputs: ['deploy'] },
  { id: 'deploy',  label: 'DEPLOY',           capacity: 1, processingTime: 300, pos: { x: 0.94, y: 0.5 }, outputs: [] },
];

export const BEFORE_STATIONS_KO: StationConfig[] = [
  { id: 'user',    label: '사용자 피드백',      capacity: 0, processingTime: 0,    pos: { x: 0.06, y: 0.5 }, outputs: ['support'] },
  { id: 'support', label: '고객지원',          capacity: 1, processingTime: 1568, pos: { x: 0.22, y: 0.5 }, outputs: ['mgmt'] },
  { id: 'mgmt',    label: '매니저',            capacity: 1, processingTime: 2400, pos: { x: 0.37, y: 0.5 }, outputs: ['dev'] },
  { id: 'dev',     label: '개발자 (AI 활용)',  capacity: 1, processingTime: 3000, pos: { x: 0.54, y: 0.5 }, outputs: ['review'] },
  { id: 'review',  label: '코드 리뷰 + QA',    capacity: 1, processingTime: 800,  pos: { x: 0.74, y: 0.5 }, outputs: ['deploy'] },
  { id: 'deploy',  label: '배포',              capacity: 1, processingTime: 1000, pos: { x: 0.94, y: 0.5 }, outputs: [] },
];

export const AFTER_STATIONS_KO: StationConfig[] = [
  { id: 'user',    label: '사용자 피드백',     capacity: 0, processingTime: 0,    pos: { x: 0.06, y: 0.5  }, outputs: ['widget'] },
  { id: 'widget',  label: 'RUNHQ',             capacity: 1, processingTime: 500,  pos: { x: 0.22, y: 0.5  }, outputs: ['agent_1', 'agent_2', 'agent_3'] },
  { id: 'agent_1', label: '코딩 agent',     capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.22 }, outputs: ['review'] },
  { id: 'agent_2', label: '코딩 agent',     capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.50 }, outputs: ['review'] },
  { id: 'agent_3', label: '코딩 agent',     capacity: 1, processingTime: 3000, pos: { x: 0.45, y: 0.78 }, outputs: ['review'] },
  { id: 'review',  label: '코드 리뷰 + QA',    capacity: 1, processingTime: 800,  pos: { x: 0.70, y: 0.5  }, outputs: ['deploy'] },
  { id: 'deploy',  label: '배포',              capacity: 1, processingTime: 300,  pos: { x: 0.94, y: 0.5  }, outputs: [] },
];

export const STATIONS_BY_LOCALE = {
  en: { before: BEFORE_STATIONS, after: AFTER_STATIONS },
  ko: { before: BEFORE_STATIONS_KO, after: AFTER_STATIONS_KO },
} as const;

class Simulation {
  stations = new Map<string, StationRuntime>();
  particles: Particle[] = [];
  shippedCount = 0;
  lastSpawn = 0;
  particleId = 0;
  outputCursors = new Map<string, number>();
  width = 0;
  height = 0;

  constructor(configs: StationConfig[]) {
    for (const c of configs) {
      this.stations.set(c.id, {
        config: c,
        slots: c.capacity > 0 ? Array(c.capacity).fill(null) : [],
      });
      this.outputCursors.set(c.id, 0);
    }
  }

  resize(w: number, h: number) { this.width = w; this.height = h; }

  posOf(id: string) {
    const s = this.stations.get(id)!;
    return { x: s.config.pos.x * this.width, y: s.config.pos.y * this.height };
  }

  nodeRadius(id: string) {
    return this.stations.get(id)!.config.capacity === 0 ? PASS_RADIUS : NODE_RADIUS;
  }

  // ─── State changes ────────────────────────────────────────────────────────
  // Particles never get their position assigned by simulation logic.
  // The only thing that ever changes is `target`. Position emerges from gravity.

  // Deterministic 0..1 hash, used for per-particle vertical spread at spawn
  hash(n: number) { return ((n * 9301 + 49297) % 233280) / 233280; }

  spawnParticle() {
    const userId = 'user';
    const user = this.stations.get(userId);
    if (!user || user.config.outputs.length === 0) return;
    const upos = this.posOf(userId);
    const id = ++this.particleId;
    this.particles.push({
      id,
      x: upos.x,
      y: upos.y + (this.hash(id) - 0.5) * SPAWN_Y_JITTER,
      vx: 0,
      vy: 0,
      target: user.config.outputs[0],
      inProcess: false,
      transitioning: true,
    });
  }

  retarget(p: Particle, fromStationId: string) {
    const s = this.stations.get(fromStationId)!;
    if (s.config.outputs.length === 0) {
      p.target = null;
      this.shippedCount++;
      return;
    }
    const cursor = this.outputCursors.get(fromStationId) ?? 0;
    p.target = s.config.outputs[cursor % s.config.outputs.length];
    this.outputCursors.set(fromStationId, cursor + 1);
    // Enter transition mode: direct velocity through any cluster until close to the new target
    p.transitioning = true;
  }

  // ─── Frame ────────────────────────────────────────────────────────────────
  step(now: number) {
    if (this.width < 100) return;

    // 1. Source: spawn one ticket per SPAWN_MS
    if (now - this.lastSpawn >= SPAWN_MS) {
      this.spawnParticle();
      this.lastSpawn = now;
    }

    // 2. Physics. Two modes:
    //      - transitioning: direct velocity toward target (ignores damping). Plows through
    //        any cluster in its way because the post-collision velocity is overwritten next
    //        frame. Switches to gravity once it reaches the new target's vicinity.
    //      - default: force-based gravity, ramped down near the target so clusters settle.
    for (const p of this.particles) {
      if (!p.target) continue;
      const tp = this.posOf(p.target);
      const dx = tp.x - p.x, dy = tp.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (p.transitioning) {
        p.vx = (dx / dist) * TRANSITION_SPEED;
        p.vy = (dy / dist) * TRANSITION_SPEED;
        if (dist < this.nodeRadius(p.target) + TRANSITION_END_BUFFER) {
          p.transitioning = false;
        }
      } else {
        const f = Math.min(GRAVITY_F, dist * GRAVITY_RAMP);
        p.vx = (p.vx + (dx / dist) * f) * DAMP;
        p.vy = (p.vy + (dy / dist) * f) * DAMP;
      }
      p.x += p.vx;
      p.y += p.vy;
    }

    // 3. Pairwise collision — position correction + impulse response.
    //    Position correction alone preserves kinetic energy; the system would orbit
    //    forever as gravity keeps adding energy. The impulse below cancels approach
    //    velocity (inelastic normal) and dissipates tangential slide (friction),
    //    so contacting particles actually come to rest.
    const min = 2 * PR;
    const TANGENT_FRICTION = 0.4;
    for (let iter = 0; iter < COLLISION_ITERS; iter++) {
      for (let i = 0; i < this.particles.length; i++) {
        const a = this.particles[i];
        for (let j = i + 1; j < this.particles.length; j++) {
          const b = this.particles[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 < 0.01) continue;
          const d = Math.sqrt(d2);
          const overlap = (min - d) * 0.5;
          const nx = dx / d, ny = dy / d;

          // Position correction
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;

          // Impulse: only act on approaching pairs
          const dvx = b.vx - a.vx;
          const dvy = b.vy - a.vy;
          const dvN = dvx * nx + dvy * ny;
          if (dvN >= 0) continue;

          // Inelastic normal — equalize velocity along the contact axis
          const halfN = dvN * 0.5;
          a.vx += halfN * nx; a.vy += halfN * ny;
          b.vx -= halfN * nx; b.vy -= halfN * ny;

          // Tangential friction — bleed the sliding component that drives rotation
          const dvTx = dvx - dvN * nx;
          const dvTy = dvy - dvN * ny;
          const ft = TANGENT_FRICTION * 0.5;
          a.vx += dvTx * ft; a.vy += dvTy * ft;
          b.vx -= dvTx * ft; b.vy -= dvTy * ft;
        }
      }
    }

    // 4. Canvas bounds
    for (const p of this.particles) {
      if (p.x < PR)               { p.x = PR;               p.vx = Math.max(0, p.vx); }
      if (p.x > this.width - PR)  { p.x = this.width - PR;  p.vx = Math.min(0, p.vx); }
      if (p.y < PR)               { p.y = PR;               p.vy = Math.max(0, p.vy); }
      if (p.y > this.height - PR) { p.y = this.height - PR; p.vy = Math.min(0, p.vy); }
    }

    // 5. Stations look at the world.
    for (const [id, s] of this.stations) {
      const sp = this.posOf(id);

      if (s.config.capacity === 0) {
        // Pass-through router: any free particle inside the radius is retargeted in place.
        const range = PASS_RADIUS + PR;
        const range2 = range * range;
        for (const p of this.particles) {
          if (p.target !== id || p.inProcess) continue;
          const dx = sp.x - p.x, dy = sp.y - p.y;
          if (dx * dx + dy * dy <= range2) this.retarget(p, id);
        }
        continue;
      }

      // Real station: each empty slot claims the closest free particle whose
      // target is this station and that has gravitated within CLAIM_DISTANCE
      // of the station's center. Claiming changes a flag and starts a timer —
      // it does NOT move the particle.
      for (let i = 0; i < s.slots.length; i++) {
        if (s.slots[i] !== null) continue;
        let best: Particle | null = null;
        let bestD = CLAIM_DISTANCE;
        for (const p of this.particles) {
          if (p.target !== id || p.inProcess) continue;
          const dx = sp.x - p.x, dy = sp.y - p.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (best) {
          best.inProcess = true;
          best.processingStart = now;
          best.processingDuration = s.config.processingTime;
          best.slotStationId = id;
          best.slotIdx = i;
          s.slots[i] = best;
        }
      }
    }

    // 6. Slots: tick processing timers. On done, release particle.
    for (const [id, s] of this.stations) {
      for (let i = 0; i < s.slots.length; i++) {
        const p = s.slots[i];
        if (!p) continue;
        if (now - (p.processingStart ?? now) >= (p.processingDuration ?? 0)) {
          s.slots[i] = null;
          p.inProcess = false;
          this.retarget(p, id);
        }
      }
    }

    // 7. Cleanup shipped particles
    this.particles = this.particles.filter(p => p.target !== null || p.inProcess);
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  draw(ctx: CanvasRenderingContext2D, now: number) {
    const w = this.width, h = this.height;
    ctx.clearRect(0, 0, w, h);

    // Edges between connected stations (faint)
    ctx.strokeStyle = 'rgba(20,19,15,0.10)';
    ctx.lineWidth = 1;
    for (const s of this.stations.values()) {
      const from = this.posOf(s.config.id);
      for (const outId of s.config.outputs) {
        const to = this.posOf(outId);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }

    // Stations
    for (const s of this.stations.values()) {
      const pos = this.posOf(s.config.id);
      const r = this.nodeRadius(s.config.id);

      ctx.strokeStyle = 'rgba(20,19,15,0.32)';
      ctx.fillStyle = 'rgba(20,19,15,0.02)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(20,19,15,0.65)';
      ctx.font = '10px ui-monospace, "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(s.config.label, pos.x, pos.y + r + 8);
    }

    // Particles
    for (const p of this.particles) {
      this.drawParticle(ctx, p.x, p.y);
      if (p.inProcess) {
        const pulse = 1 + Math.sin(now * 0.006 + (p.slotIdx ?? 0)) * 0.2;
        ctx.strokeStyle = 'rgba(82,75,180,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (PR + 4) * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  drawParticle(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.fillStyle = '#5a4fa5';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

const PIPELINE_T = {
  en: { shipped: 'shipped' },
  ko: { shipped: '배포됨' },
} as const;

export function PipelineCanvas({
  configs,
  label,
  resetTick,
  height,
}: {
  configs: StationConfig[];
  label: string;
  resetTick: number;
  height: number;
}) {
  const t = useT(PIPELINE_T);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [shipped, setShipped] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const sim = new Simulation(configs);
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const startTime = performance.now();
    let raf = 0;
    let cancelled = false;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(320, rect.width);
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sim.resize(w, height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const loop = (now: number) => {
      if (cancelled) return;
      const t = now - startTime;
      sim.step(t);
      sim.draw(ctx, t);
      setShipped(sim.shippedCount);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [configs, resetTick, height]);

  return (
    <div className="vp-pipeline">
      <div className="vp-pipeline-head">
        <span className="vp-pipeline-label">{label}</span>
        <span className="vp-stat">
          <span className="vp-stat-num">{shipped}</span>
          <span className="vp-stat-lbl">{t.shipped}</span>
        </span>
      </div>
      <div className="vp-canvas-wrap" ref={wrapRef} style={{ height }}>
        <canvas ref={canvasRef} className="vp-canvas" />
      </div>
    </div>
  );
}

const VISUAL_T = {
  en: {
    eyebrow: 'EXPERIMENT · VISUAL',
    titleLead: 'Same input, different system. ',
    titleEm: 'Throughput is downstream of structure.',
    sub: 'Both pipelines receive feedback at the same rate. Each station has a fixed processing time. Watch the bottlenecks emerge.',
    labelBefore: 'BEFORE',
    labelAfter: 'WITH RUNHQ',
  },
  ko: {
    eyebrow: '실험 · 비주얼',
    titleLead: '같은 입력, 다른 시스템. ',
    titleEm: '처리량은 구조의 결과입니다.',
    sub: '두 파이프라인 모두 같은 속도로 피드백을 받습니다. 각 스테이션의 처리 시간은 고정되어 있습니다. 병목이 어떻게 드러나는지 지켜보세요.',
    labelBefore: '기존 방식',
    labelAfter: 'RUNHQ 도입 후',
  },
} as const;

export default function VisualPage() {
  const t = useT(VISUAL_T);
  const locale = useLocale();
  const stations = STATIONS_BY_LOCALE[locale];
  const [resetTick, setResetTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setResetTick(t => t + 1), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="vp-root">
      <style>{VP_STYLES}</style>
      <Navbar />

      <section className="vp-hero">
        <div className="vp-hero-inner">
          <div className="vp-eyebrow mono">{t.eyebrow}</div>
          <h1 className="vp-title">
            {t.titleLead}<em>{t.titleEm}</em>
          </h1>
          <p className="vp-sub">
            {t.sub}
          </p>
        </div>
      </section>

      <section className="vp-section">
        <PipelineCanvas configs={stations.before} label={t.labelBefore} resetTick={resetTick} height={200} />
        <PipelineCanvas configs={stations.after} label={t.labelAfter} resetTick={resetTick} height={360} />
      </section>

      <Footer />
    </div>
  );
}

export const VP_STYLES = `
.vp-root {
  background: var(--rhw-bg);
  min-height: 100vh;
  color: var(--rhw-ink);
}

.vp-hero {
  padding: 64px 24px 24px;
  max-width: 1100px;
  margin: 0 auto;
}
.vp-hero-inner { display: flex; flex-direction: column; gap: 16px; }
.vp-eyebrow {
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--rhw-ink-mute);
}
.vp-title {
  font-size: clamp(28px, 4vw, 44px);
  letter-spacing: -0.02em;
  line-height: 1.1;
  margin: 0;
  font-weight: 600;
  color: var(--rhw-ink);
}
.vp-title em {
  font-style: normal;
  color: var(--rhw-ink-mute);
  font-weight: 400;
}
.vp-sub {
  font-size: 15px;
  line-height: 1.55;
  color: var(--rhw-ink-soft);
  margin: 0;
  max-width: 640px;
}

.vp-section {
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px 24px 80px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.vp-pipeline {
  border: 1px solid var(--rhw-line);
  border-radius: 14px;
  overflow: hidden;
  background: transparent;
}
.vp-pipeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: transparent;
  border-bottom: 1px solid var(--rhw-line);
}
.vp-pipeline-label {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--rhw-ink-soft);
}
.vp-stat { display: flex; align-items: baseline; gap: 6px; line-height: 1; }
.vp-stat-num {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 18px;
  font-weight: 600;
  color: var(--rhw-ink);
  font-variant-numeric: tabular-nums;
}
.vp-stat-lbl {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--rhw-ink-mute);
}
.vp-canvas-wrap {
  width: 100%;
  background: transparent;
  position: relative;
}
.vp-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
`;
