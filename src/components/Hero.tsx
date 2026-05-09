import { useEffect, useRef } from 'react';

const SIGNUP_URL = 'https://app.runhq.io/signup';
const LOGIN_URL = 'https://app.runhq.io';

const PALETTE = {
  A:  [0.22, 0.95, 0.85],
  B:  [0.55, 1.00, 0.55],
  C:  [1.00, 0.78, 0.35],
  BG: [0.02, 0.05, 0.07],
};

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform vec2  uRes;
uniform float uIntensity;
uniform vec3  uColA;
uniform vec3  uColB;
uniform vec3  uColC;
uniform vec3  uColBG;
uniform float uHeart;

float hash(vec2 p) { p = fract(p*vec2(234.34,435.345)); p += dot(p, p+34.23); return fract(p.x*p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i=0; i<4; i++) {
    v += a * noise(p);
    p = p*2.02 + vec2(13.1, 7.3);
    a *= 0.5;
  }
  return v;
}
float warp(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, t*0.12)), fbm(p + vec2(5.2, -t*0.09)));
  vec2 r = vec2(fbm(p + 4.0*q + vec2(1.7, 9.2) + t*0.15),
                fbm(p + 4.0*q + vec2(8.3, 2.8) - t*0.17));
  return fbm(p + 4.0*r);
}

float creatureField(vec2 p, float t, float heart) {
  float r = length(p);
  float slow = warp(p * 0.9 + vec2(t*0.03, -t*0.025), t*0.2);
  float veryslow = fbm(p * 0.5 + vec2(-t*0.015, t*0.012));
  float pulse = heart * 0.06;
  float baseR = 0.48 + (slow - 0.5) * 0.35 + (veryslow - 0.5) * 0.20 + pulse;
  float body = smoothstep(baseR + 0.22, baseR - 0.04, r);
  float w = warp(p * 2.0 + vec2(t*0.05, 0.0), t*0.3);
  float veins = smoothstep(0.42, 0.80, w);
  float modu = 0.5 + 0.5 * (fbm(p*3.0 - vec2(t*0.05, t*0.04)) - 0.5);
  return body * (0.3 + 0.7*veins) * (0.75 + 0.25*modu);
}

void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(uRes.x/uRes.y, 1.0) * 2.0;
  float t = uTime;

  float field = creatureField(p, t, uHeart) * uIntensity;

  float bgGlow = smoothstep(1.4, 0.0, length(p)) * 0.22;
  float flowW = warp(p*1.2 + vec2(t*0.06, -t*0.04), t*0.4);
  float streams = smoothstep(0.65, 0.95, flowW);
  float bodyMask = smoothstep(0.95, 0.25, length(p));
  float nutrients = streams * bodyMask * 0.35;

  float iri = 0.5 + 0.5 * (fbm(p*0.8 + vec2(t*0.03, -t*0.02)) - 0.5) * 2.0;
  vec3 iriColor = mix(uColA, uColB, iri);

  vec3 col = uColBG * 0.6;
  col += iriColor * pow(field, 1.2) * 1.1;
  col += uColB * pow(field, 3.0) * 1.6;
  col += vec3(1.0, 0.92, 0.78) * pow(field, 7.0) * (0.5 + uHeart*0.35);
  col += nutrients * mix(uColB, vec3(1.0,0.95,0.85), 0.4) * 1.4;
  col += uColA * bgGlow;

  float edge = abs(fbm(p*3.0 + t*0.05) - 0.5);
  edge = smoothstep(0.02, 0.0, edge - 0.08);
  col *= 1.0 - edge*0.4;

  col *= smoothstep(1.6, 0.2, length(p*vec2(0.9,1.0)));
  col += (hash(uv*uRes + t) - 0.5) * 0.025;

  col = col / (col + vec3(0.9));
  col = pow(col, vec3(0.92));

  gl_FragColor = vec4(col, 1.0);
}
`;

const SPEED = 0.45;

export default function Hero() {
  const heroRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const hero = heroRef.current;
    if (!canvas || !hero) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import('three');
      if (cancelled || !canvas || !hero) return;

      let renderer: import('three').WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: false,
          alpha: false,
          powerPreference: 'low-power',
        });
      } catch {
        return; // No WebGL — leave the dark background as-is.
      }
      renderer.setPixelRatio(1);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

      const uniforms = {
        uTime:      { value: 0 },
        uRes:       { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: 1.0 },
        uColA:      { value: new THREE.Vector3(PALETTE.A[0], PALETTE.A[1], PALETTE.A[2]) },
        uColB:      { value: new THREE.Vector3(PALETTE.B[0], PALETTE.B[1], PALETTE.B[2]) },
        uColC:      { value: new THREE.Vector3(PALETTE.C[0], PALETTE.C[1], PALETTE.C[2]) },
        uColBG:     { value: new THREE.Vector3(PALETTE.BG[0], PALETTE.BG[1], PALETTE.BG[2]) },
        uHeart:     { value: 0 },
      };

      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
      });
      const geom = new THREE.PlaneGeometry(2, 2);
      const quad = new THREE.Mesh(geom, mat);
      scene.add(quad);

      function resize() {
        const w = hero!.clientWidth;
        const h = hero!.clientHeight;
        renderer.setSize(w, h, false);
        uniforms.uRes.value.set(w, h);
      }
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(hero);

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      let last = performance.now() / 1000;
      let raf = 0;
      function tick() {
        const now = performance.now() / 1000;
        const dt = Math.min(now - last, 0.05);
        last = now;
        uniforms.uTime.value += dt * SPEED;

        const heartCycle = 6.5;
        const hp = (uniforms.uTime.value % heartCycle) / heartCycle;
        const bump = (x: number, c: number, w: number) => Math.exp(-Math.pow((x - c) / w, 2));
        const h = bump(hp, 0.05, 0.04) + 0.55 * bump(hp, 0.18, 0.06);
        uniforms.uHeart.value = Math.min(1, h);

        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      }

      function start() {
        if (raf || reducedMotion) return;
        last = performance.now() / 1000;
        raf = requestAnimationFrame(tick);
      }
      function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }

      // Pause when the hero scrolls out of view.
      const io = new IntersectionObserver(([entry]) => {
        entry.isIntersecting ? start() : stop();
      }, { threshold: 0 });
      io.observe(hero);

      // Render exactly one frame for reduced-motion users so the canvas isn't blank.
      if (reducedMotion) renderer.render(scene, camera);

      cleanup = () => {
        stop();
        io.disconnect();
        ro.disconnect();
        mat.dispose();
        geom.dispose();
        renderer.dispose();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="rh-hero" ref={heroRef}>
      <style>{HERO_STYLES}</style>
      <canvas ref={canvasRef} className="rh-stage" />

      <header className="rh-topbar">
        <div className="rh-brand">
          <div className="rh-mark" />
          <span>RunHQ</span>
        </div>
        <div className="rh-top-right">
          <a className="rh-btn-sign" href={LOGIN_URL}>Sign in</a>
        </div>
      </header>

      <div className="rh-copy">
        <h1 className="rh-tagline">Watch your app <em>build itself</em></h1>
        <p className="rh-sub">
          RunHQ collects user feedback, AI agents build from it, and <strong>you decide what ships.</strong>
        </p>
        <div className="rh-ctas">
          <a className="rh-btn rh-btn-primary" href={SIGNUP_URL}>
            Get Started
          </a>
        </div>
      </div>

    </div>
  );
}

const HERO_STYLES = `
  .rh-hero {
    --bg-deep:  #050608;
    --ink:      oklch(0.97 0.005 240);
    --ink-dim:  oklch(0.72 0.012 240);
    --ink-faint:oklch(0.48 0.012 240);
    --line:     oklch(0.26 0.015 240 / 0.45);
    --accent:   oklch(0.86 0.19 180);
    --accent-2: oklch(0.82 0.21 145);
    --accent-3: oklch(0.82 0.18 70);

    position: relative;
    width: 100%;
    height: 100vh;
    height: 100svh;
    min-height: 640px;
    overflow: hidden;
    background: var(--bg-deep);
    color: var(--ink);
    font-family: 'Inter Tight', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .rh-hero *, .rh-hero *::before, .rh-hero *::after { box-sizing: border-box; }
  .rh-hero .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }

  .rh-stage {
    position: absolute; inset: 0;
    display: block;
    width: 100%; height: 100%;
  }

  .rh-hero::after {
    content: "";
    position: absolute; inset: 0;
    background:
      radial-gradient(ellipse 90% 70% at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%),
      repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px);
    pointer-events: none;
  }

  /* Top bar */
  .rh-topbar {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; justify-content: space-between; align-items: center;
    padding: 22px 32px;
    z-index: 10;
  }
  .rh-brand {
    display: flex; align-items: center; gap: 10px;
    font-size: 15px; font-weight: 600; letter-spacing: -0.01em;
  }
  .rh-mark { width: 18px; height: 18px; position: relative; }
  .rh-mark::before, .rh-mark::after {
    content: ""; position: absolute; inset: 0;
    border: 1.5px solid var(--accent);
    border-radius: 50%;
  }
  .rh-mark::after { animation: rh-ring 2.2s ease-out infinite; }
  @keyframes rh-ring {
    0%   { transform: scale(1);   opacity: 1; }
    100% { transform: scale(2.2); opacity: 0; }
  }
  .rh-top-right {
    display: flex; gap: 10px; align-items: center;
    justify-self: end;
  }
  .rh-btn-sign {
    color: var(--ink); text-decoration: none;
    font-size: 13px; padding: 8px 14px;
    border-radius: 8px; border: 1px solid var(--line);
    background: rgba(10,12,16,0.5); backdrop-filter: blur(10px);
  }
  .rh-btn-sign:hover { border-color: var(--accent); color: var(--accent); }

  /* Center copy */
  .rh-copy {
    position: absolute;
    inset: 0;
    z-index: 4;
    padding: 96px 32px 72px;
    text-align: center;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
  }
  .rh-copy > * { pointer-events: auto; }
  .rh-tagline {
    font-size: clamp(36px, 5.4vw, 88px);
    font-weight: 500;
    line-height: 0.95;
    letter-spacing: -0.045em;
    margin: 0 auto 26px;
    max-width: 1200px;
    color: var(--ink);
    text-wrap: balance;
  }
  .rh-tagline em {
    font-style: normal;
    background: linear-gradient(100deg,
      oklch(0.96 0.14 180) 0%,
      oklch(0.88 0.22 160) 45%,
      oklch(0.85 0.22 130) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .rh-sub {
    font-size: clamp(17px, 1.35vw, 20px);
    line-height: 1.55;
    color: oklch(0.92 0.01 240);
    max-width: 640px;
    margin: 0 auto 32px;
    text-wrap: pretty;
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
  }
  .rh-sub strong { color: var(--ink); font-weight: 500; }
  .rh-ctas { display: inline-flex; gap: 12px; align-items: center; }
  .rh-btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 14px 22px;
    font-family: inherit;
    font-size: 14px; font-weight: 500;
    border-radius: 10px;
    text-decoration: none; cursor: pointer;
    transition: transform .18s, background .2s, border-color .2s;
  }
  .rh-btn-primary {
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    color: #061014;
    border: 1px solid oklch(0.86 0.18 180);
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.25),
      0 12px 44px -10px oklch(0.86 0.19 180 / 0.55),
      inset 0 1px 0 rgba(255,255,255,0.35);
  }
  .rh-btn-primary:hover { transform: translateY(-1px); }
  .rh-btn-ghost {
    background: rgba(12,14,18,0.55); color: var(--ink);
    border: 1px solid var(--line); backdrop-filter: blur(10px);
  }
  .rh-btn-ghost:hover { border-color: var(--accent); color: var(--accent); }

  @media (max-width: 700px) {
    .rh-hero { min-height: 560px; }
    .rh-copy { padding: 80px 22px 72px; }
    .rh-tagline { margin-bottom: 18px; }
    .rh-sub { margin-bottom: 22px; }
  }
`;
