import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import HeroNavbar from './HeroNavbar';

const SIGNUP_URL = 'https://app.runhq.io/signup';

const CHIP_PROMPTS = [
  'Develop app based on user feedback',
  'Make daily X post',
  'Optimize paid marketing funnel',
  'Create and post blog articles',
  'Handle contact form submissions',
];

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

export type HeroVariant = 'default' | 'automate';

export default function Hero({ variant = 'default' }: { variant?: HeroVariant } = {}) {
  const heroRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');

  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    window.location.href = `${SIGNUP_URL}?prompt=${encodeURIComponent(trimmed)}`;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleChipClick(text: string) {
    setPrompt(text);
    textareaRef.current?.focus();
  }

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

      <HeroNavbar />

      <div className="rh-copy">
        {variant === 'automate' ? (
          <>
            <h1 className="rh-tagline rh-tagline-platform">
              Build at lightspeed.<br />Stay in the loop.
            </h1>
            <p className="rh-sub-platform">
              RunHQ turns user feedback into shipped product — with full receipts at every step.
            </p>
            <div className="rh-pillars">
              <div className="rh-pillar">
                <div className="rh-pillar-label">Build at lightspeed</div>
                <div className="rh-pillar-desc">Agents ship in hours, not sprints.</div>
              </div>
              <div className="rh-pillar">
                <div className="rh-pillar-label">Full transparency</div>
                <div className="rh-pillar-desc">Every change traces back to user feedback.</div>
              </div>
              <div className="rh-pillar">
                <div className="rh-pillar-label">Closed feedback loop</div>
                <div className="rh-pillar-desc">Feedback in. Product out. Repeat.</div>
              </div>
            </div>
            <div className="rh-prompt-form">
              <textarea
                ref={textareaRef}
                className="rh-prompt-input"
                placeholder="Describe a workflow…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={3}
                maxLength={500}
              />
              <button
                type="button"
                className="rh-prompt-submit"
                onClick={handleSubmit}
                disabled={!prompt.trim()}
                aria-label="Submit"
              >
                →
              </button>
            </div>
            <div className="rh-chips">
              {CHIP_PROMPTS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="rh-chip"
                  onClick={() => handleChipClick(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h1 className="rh-tagline">Watch your app <em>build itself</em></h1>
            <p className="rh-sub">
              RunHQ collects user feedback, AI agents build from it, and <strong>you decide what ships.</strong>
            </p>
            <div className="rh-ctas">
              <a className="rh-btn rh-btn-primary" href={SIGNUP_URL}>
                Get Started
              </a>
            </div>
          </>
        )}
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

  /* Automate variant: tighter headline + pillars */
  .rh-tagline-platform {
    font-size: clamp(34px, 4.6vw, 68px);
    line-height: 1.02;
    margin-bottom: 20px;
  }
  .rh-sub-platform {
    font-size: clamp(15px, 1.2vw, 18px);
    line-height: 1.55;
    color: oklch(0.88 0.01 240);
    max-width: 640px;
    margin: 0 auto 28px;
    text-wrap: pretty;
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.55);
  }
  .rh-pillars {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 24px;
    max-width: 760px;
    width: 100%;
    margin: 0 auto 32px;
    text-align: left;
  }
  .rh-pillar {
    padding: 14px 16px;
    border-left: 1.5px solid oklch(0.86 0.19 180 / 0.55);
    background: rgba(14, 17, 22, 0.4);
    backdrop-filter: blur(8px);
    border-radius: 0 10px 10px 0;
  }
  .rh-pillar-label {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: oklch(0.96 0.005 240);
    margin-bottom: 4px;
  }
  .rh-pillar-desc {
    font-size: 12.5px;
    line-height: 1.45;
    color: oklch(0.74 0.01 240);
  }

  /* Prompt input */
  .rh-prompt-form {
    position: relative;
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
  }
  .rh-prompt-input {
    width: 100%;
    min-height: 120px;
    padding: 18px 20px 56px;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    color: var(--ink);
    background: rgba(14, 17, 22, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 16px;
    resize: none;
    outline: none;
    backdrop-filter: blur(14px);
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .rh-prompt-input::placeholder { color: var(--ink-faint); }
  .rh-prompt-input:focus {
    border-color: oklch(0.86 0.19 180 / 0.45);
    box-shadow: 0 0 0 1px oklch(0.86 0.19 180 / 0.08);
  }
  .rh-prompt-submit {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 600;
    line-height: 1;
    color: #061014;
    background: linear-gradient(180deg, oklch(0.93 0.17 180), oklch(0.78 0.2 180));
    border: 1px solid oklch(0.86 0.18 180);
    border-radius: 50%;
    cursor: pointer;
    box-shadow:
      0 0 0 1px oklch(0.86 0.19 180 / 0.25),
      0 8px 24px -8px oklch(0.86 0.19 180 / 0.55),
      inset 0 1px 0 rgba(255,255,255,0.35);
    transition: transform 0.18s, opacity 0.18s;
  }
  .rh-prompt-submit:hover:not(:disabled) { transform: translateY(-1px); }
  .rh-prompt-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Suggestion chips */
  .rh-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    margin-top: 18px;
    max-width: 720px;
  }
  .rh-chip {
    font-family: inherit;
    font-size: 13px;
    color: var(--ink);
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(14, 17, 22, 0.6);
    backdrop-filter: blur(10px);
    cursor: pointer;
    transition: border-color 0.18s, color 0.18s;
  }
  .rh-chip:hover { border-color: var(--accent); color: var(--accent); }

  @media (max-width: 700px) {
    .rh-hero { min-height: 560px; }
    .rh-copy { padding: 80px 22px 72px; }
    .rh-tagline { margin-bottom: 18px; }
    .rh-sub { margin-bottom: 22px; }
    .rh-prompt-input { min-height: 110px; }
    .rh-chip { font-size: 12px; padding: 7px 12px; }
    .rh-pillars { grid-template-columns: 1fr; gap: 8px; margin-bottom: 24px; }
    .rh-pillar { padding: 10px 14px; }
  }
`;
