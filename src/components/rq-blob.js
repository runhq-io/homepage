// Pixel blob hero effect, ported verbatim from the "RunHQ Homepage v10" design
// bundle (rq-blob.js). Registers the <rq-blob> custom element on import.
(() => {
  if (customElements.get('rq-blob')) return;
  const M = 260, PI = Math.PI;
  const cs = (a, b, r0, r1, n0) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); r0 = Math.max(r0, .07); r1 = Math.max(r1, .06); const n = Math.max(n0, Math.ceil(len / (Math.min(r0, r1) * .55)) + 1); return Array.from({ length: n }, (_, i) => { const t = n === 1 ? .5 : i / (n - 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, r0 + (r1 - r0) * t]; }); };
  const off = (L, o) => L.map(s => [s[0] + o[0], s[1] + o[1], s[2] + o[2], s[3]]);
  const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
  const fib = (n, i) => { const y = 1 - (i + .5) / n * 2, r = Math.sqrt(1 - y * y), a = i * 2.39996; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
  const SHAPES = [
    T => Array.from({ length: 34 }, (_, i) => { const p = fib(34, i), wb = 1 + .07 * Math.sin(T * .7 + i * 1.9) + .05 * Math.sin(T * .45 + p[1] * 3); return [p[0] * .5 * wb * 1.06, p[1] * .5 * wb * .94, p[2] * .5 * wb, .45 + .02 * Math.sin(T * .9 + i * 2.3)]; }),
    T => { const L = cs([-.9, 0, 0], [.6, 0, 0], .36, .36, 10); for (let f = 0; f < 3; f++) { let prev = [.75, (f - 1) * .1, Math.cos(f * 2.1) * .1]; for (let j = 1; j <= 8; j++) { const x = .75 + j * .15, p = [x, Math.sin(j * .8 - T * 4 + f * 2) * .14 * (j / 8) + (f - 1) * .1, Math.cos(f * 2.1) * .1]; L.push(...cs(prev, p, .07, .06, 2)); prev = p; } } return off(L, [-.25, 0, 0]); },
    T => Array.from({ length: 18 }, (_, i) => { const x = -1.7 + i * 3.4 / 17; return [x, Math.sin(x * 2.2 - T * 1.5) * .25, Math.cos(x * 1.4 - T) * .12, .05 + .2 * Math.sqrt(Math.max(0, 1 - Math.pow(x / 1.9, 2)))]; }),
    T => { const w = Math.sin(T * 3); const L = []; for (let i = 0; i < 12; i++) { const x = 1.15 - i * 2.05 / 11; L.push([x, 0, Math.max(0, -x) * w * .12, .05 + .42 * Math.sqrt(Math.max(0, 1 - Math.pow((x - .15) / 1.2, 2)))]); } [1, -1].forEach(s => L.push(...cs([-1.0, 0, w * .14], [-1.6, .55 * s, w * .3], .1, .06, 4))); L.push(...cs([.25, .4, 0], [-.2, .7, 0], .1, .04, 3)); return off(L, [.2, 0, 0]); },
    T => { const g = T * 2; const L = [...cs([-.75, 0, 0], [.75, 0, 0], .28, .28, 8), ...cs([.95, .05, 0], [1.35, .02, 0], .24, .14, 3), ...cs([-.85, 0, 0], [-2.0, -.08, Math.sin(T) * .2], .16, .04, 8)]; [[.5, 1, 0], [.5, -1, PI], [-.45, 1, PI], [-.45, -1, 0]].forEach(([x, s, p]) => { const sw = Math.sin(g + p) * .14, h = [x, -.05, .28 * s], k = [x + .12 + sw, -.25, .6 * s], f = [x + .22 + sw * 1.4, -.42, .64 * s]; L.push(...cs(h, k, .08, .07, 2), ...cs(k, f, .07, .06, 2)); }); return off(L, [.35, .1, 0]); },
    T => { const g = T * 2.4, bob = Math.abs(Math.sin(g)) * .025, hb = Math.sin(g * 2) * .03; const L = [...cs([-.75, .28, 0], [.75, .28, 0], .38, .36, 8), ...cs([.75, .45, 0], [1.0, .78 + hb, 0], .2, .16, 3), ...cs([1.05, .86 + hb, 0], [1.45, .78 + hb, 0], .22, .11, 3), ...cs([-.8, .35, 0], [-1.3, -.05, Math.sin(g) * .15], .07, .04, 3)]; [[.55, 1, 0], [.55, -1, PI], [-.55, 1, PI], [-.55, -1, 0]].forEach(([x, s, p]) => { const ph = g + p, h = [x, .05, .2 * s], a = Math.sin(ph) * .38, k = add(h, [Math.sin(a), -Math.cos(a), 0], .55), a2 = a - .35 * Math.max(0, Math.sin(ph + 1.4)), f = add(k, [Math.sin(a2), -Math.cos(a2), 0], .52); L.push(...cs(h, k, .11, .09, 3), ...cs(k, f, .085, .07, 3)); }); return off(L, [-.05, .15 + bob, 0]); },
    T => { const sw = Math.sin(T * 1.6) * .06; const L = [...cs([-.05, -.15, 0], [.3, .85, 0], .36, .34, 6), ...cs([.5, 1.18, 0], [.72, 1.12, 0], .25, .14, 2)]; [1, -1].forEach(s => { const sh = [.3, .8, .42 * s], el = [.55, -.1, .5 * s], ha = [.7 + sw * s, -1.0, .45 * s], hp = [-.05, -.2, .22 * s], kn = [.25, -.6, .28 * s], ft = [.05, -1.0, .28 * s]; L.push(...cs(sh, el, .1, .09, 4), ...cs(el, ha, .09, .08, 4), ...cs(hp, kn, .13, .12, 3), ...cs(kn, ft, .11, .09, 3)); }); return off(L, [-.15, -.1, 0]); },
    T => { const g = T * 2.2, bob = Math.abs(Math.cos(g)) * .04; const L = [...cs([.02, 1.45, 0], [.02, 1.56, 0], .2, .19, 2), ...cs([.01, 1.22, 0], [.02, 1.32, 0], .08, .08, 2), ...cs([0, .15, -.12], [0, .15, .12], .2, .2, 2)]; [1, -1].forEach(s => { L.push(...cs([0, .35, .12 * s], [0, 1.08, .14 * s], .2, .22, 4)); const ph = g + (s > 0 ? 0 : PI); { const sh = [0, 1.08, .38 * s], a = -Math.sin(ph) * .4, e = add(sh, [Math.sin(a), -Math.cos(a), 0], .52), a2 = a + .3 + Math.max(0, -Math.sin(ph)) * .25, w = add(e, [Math.sin(a2), -Math.cos(a2), 0], .48); L.push(...cs(sh, e, .08, .07, 4), ...cs(e, w, .065, .055, 4)); } { const h = [0, .1, .15 * s], a = Math.sin(ph) * .45, k = add(h, [Math.sin(a), -Math.cos(a), 0], .8), a2 = a - (.08 + .65 * Math.max(0, Math.sin(ph - 1.9))), an = add(k, [Math.sin(a2), -Math.cos(a2), 0], .78); L.push(...cs(h, k, .12, .1, 5), ...cs(k, an, .09, .07, 5), ...cs(add(an, [-.04, -.04, 0], 1), add(an, [.2, -.07, 0], 1), .06, .05, 2)); } }); return off(L, [.05, -.12 + bob, 0]); }
  ];
  const fit = L => Array.from({ length: M }, (_, i) => i < L.length ? L[i] : [L[i % L.length][0], L[i % L.length][1], L[i % L.length][2], 0]);
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);

  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;
  const sm = t => { t = clamp01(t); return .5 - .5 * Math.cos(t * PI); };
  const lerp = (x, y, t) => x + (y - x) * t;
  // Catmull-Rom through keyframes [t, v] (times ascending) - C1 continuous camera
  const spline = (K, t) => {
    let n = 0; while (n < K.length - 2 && t > K[n + 1][0]) n++;
    const p0 = K[Math.max(0, n - 1)], p1 = K[n], p2 = K[n + 1], p3 = K[Math.min(K.length - 1, n + 2)];
    const u = clamp01((t - p1[0]) / (p2[0] - p1[0])), u2 = u * u, u3 = u2 * u;
    const m1 = (p2[1] - p0[1]) / ((p2[0] - p0[0]) || 1) * (p2[0] - p1[0]), m2 = (p3[1] - p1[1]) / ((p3[0] - p1[0]) || 1) * (p2[0] - p1[0]);
    return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
  };

  // One generation: rest -> split -> evolve -> select -> settle (seconds, before SLOW)
  const SEG = { rest: 1.2, split: 3, evolve: 6, select: 3.6, settle: 3 };
  const T_SPLIT = SEG.rest, T_EVOLVE = T_SPLIT + SEG.split, T_SELECT = T_EVOLVE + SEG.evolve, T_SETTLE = T_SELECT + SEG.select, T_GEN = T_SETTLE + SEG.settle;
  const NI = 5, SC = .4, RR = 1.7, OMEGA = .17, D = 8.4, TH = .38, KR = 1.9;
  const NS = SHAPES.length, NB = 9, MM = M + NB;

  class RqBlob extends HTMLElement {
    connectedCallback() {
      if (this._init && !this._dead) return;
      this._init = true; this._dead = false; this.innerHTML = '';
      Object.assign(this.style, { display: 'block', position: 'relative', width: '100%', height: '100%' });
      const RES = +(this.getAttribute('res') || 150), ZOOM = +(this.getAttribute('zoom') || 1), SLOW = +(this.getAttribute('slow') || 1);
      const c = document.createElement('canvas');
      c.style.cssText = 'width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:crisp-edges';
      this.appendChild(c);
      const ctx = c.getContext('2d');

      // --- render buffers (resolution chosen once from a short probe) ---
      let res = RES, Wc = 0, Hc = 0, img, px, fld, probeN = 0, probeT = 0;
      const alloc = () => {
        const ar = Math.max(.3, Math.min(4, (this.clientWidth || 1) / (this.clientHeight || 1))), w = Math.max(8, Math.round(res * ar));
        if (w === Wc && Hc === res) return;
        Wc = w; Hc = res; c.width = Wc; c.height = Hc;
        img = ctx.createImageData(Wc, Hc); px = img.data; fld = new Float32Array(Wc * Hc);
        for (let p = 0; p < Wc * Hc; p++) { px[p * 4] = 20; px[p * 4 + 1] = 20; px[p * 4 + 2] = 18; }
      };

      // --- lineage state, updated only at generation boundaries ---
      const delay = Array.from({ length: MM }, () => Math.random());
      const DR = Array.from({ length: MM }, () => Math.random());
      let BUDA = [];
      let gen = 0, species = 0;
      let PM = new Array(M).fill(1), PPX = 1, PPY = 1, PSO = 0;
      const kids = Array.from({ length: NI }, () => ({ mut: null, px: 1, py: 1, warp: null, face: 0 }));
      let WIN = 0, RING = 0;
      const yawAt = tAbs => -.6 + OMEGA * tAbs;
      const spawn = genStart => {
        const keep = species === 0 ? 0 : .6;
        WIN = Math.floor(Math.random() * NI);
        BUDA = Array.from({ length: NB }, () => [Math.random(), .7 + Math.random() * .9, Math.random() * 6]);
        // place the ring so the winner rotates to the front mid-selection
        RING = PI / 2 - yawAt(genStart + T_SELECT + SEG.select * .75) - WIN / NI * PI * 2;
        kids.forEach((k, j) => {
          const w = j === WIN, amp = w ? .3 : .75 + Math.random() * .35, f1 = .8 + Math.random() * 2.2, f2 = Math.random() * 6, f3 = 3 + Math.random() * 4;
          k.mut = Array.from({ length: M }, (_, i) => Math.min(1.9, Math.max(.4, (1 + (PM[i] - 1) * keep) * (1 + amp * (.75 * Math.sin(i * f1 * .1 + f2) + .25 * Math.sin(i * f3 * .1))))));
          const st = w ? .3 : .8;
          k.px = (1 + (PPX - 1) * keep) * (1 + (Math.random() - .5) * st);
          k.py = (1 + (PPY - 1) * keep) * (1 + (Math.random() - .5) * st);
          k.warp = w ? null : [.18 + Math.random() * .3, 1.5 + Math.random() * 3, Math.random() * 6];
          k.face = (Math.random() - .5) * 1.6;
        });
      };
      const inherit = () => {
        const k = kids[WIN];
        PM = k.mut.slice(); PPX = k.px; PPY = k.py; PSO += k.face;
        species = (species + 1) % NS; gen++;
      };
      spawn(0);

      // --- per-instance pose at generation time tg ---
      const pose = (j, tg) => {
        const isP = j < 0, isW = j === WIN;
        const a = isP ? 0 : j / NI * PI * 2 + RING, rx = isP ? 0 : Math.cos(a) * RR, rz = isP ? 0 : Math.sin(a) * RR;
        const aw = WIN / NI * PI * 2 + RING, wx0 = Math.cos(aw) * RR, wz0 = Math.sin(aw) * RR;
        const o = { x: 0, z: 0, y: 0, scl: 1, mu: 0, k: 0, dis: 0, w: 1, hide: false };
        if (isP) { o.hide = tg >= T_SPLIT; return o; }
        if (tg < T_SPLIT) { o.hide = true; return o; }
        if (tg < T_EVOLVE) {
          const p = sm((tg - T_SPLIT - .04 * Math.abs(j - 2) * SEG.split) / (SEG.split * .92));
          o.x = rx * p; o.z = rz * p; o.scl = lerp(1, SC, p); o.w = 1 / (1 + (NI - 1) * Math.pow(1 - p, 1.5)); o.y = Math.sin(p * PI) * .12 * (j % 2 ? 1 : -1);
          return o;
        }
        o.x = rx; o.z = rz; o.scl = SC;
        if (tg < T_SELECT) { const p = clamp01((tg - T_EVOLVE) / SEG.evolve); o.mu = sm(p); o.k = p; return o; }
        o.mu = 1; o.k = 1;
        const out = s => { o.x = rx + (rx - wx0) * s; o.z = rz + (rz - wz0) * s; };
        if (tg < T_SETTLE) { if (!isW) { const p = sm((tg - T_SELECT) / SEG.select); o.dis = .9 * p; out(.9 * p); } return o; }
        const p = sm((tg - T_SETTLE) / SEG.settle);
        if (isW) { o.x = rx * (1 - p); o.z = rz * (1 - p); o.scl = lerp(SC, 1, p); }
        else { const q = sm((tg - T_SETTLE) / (SEG.settle * .3)); o.dis = .9 + .1 * q; out(.9 + .4 * q); if (q >= 1) o.hide = true; }
        return o;
      };

      // --- camera as a pure function of time (no state, no snapping) ---
      const camera = (tg, tAbs) => {
        const aw = WIN / NI * PI * 2 + RING, wx0 = Math.cos(aw) * RR, wz0 = Math.sin(aw) * RR;
        const PIT = [[0, .32], [T_SPLIT, .32], [T_EVOLVE, .5], [T_SELECT, .44], [T_SETTLE, .28], [T_GEN, .32]];
        const ZM = [[0, 1], [T_SPLIT, 1], [T_EVOLVE, .92], [T_SELECT, 1.04], [T_SETTLE, 2.2]];
        const cam = { yaw: yawAt(tAbs), pit: spline(PIT, tg), zoom: 1, tx: 0, tz: 0 };
        if (tg < T_SETTLE) {
          cam.zoom = spline(ZM, tg);
          const p = sm((tg - T_SELECT) / SEG.select); cam.tx = wx0 * p; cam.tz = wz0 * p;
        } else {
          // winner grows while camera pulls back: keep its on-screen size changing linearly
          const p = sm((tg - T_SETTLE) / SEG.settle), scl = lerp(SC, 1, p);
          cam.zoom = lerp(2.2 * SC, 1, p) / scl; cam.tx = wx0 * (1 - p); cam.tz = wz0 * (1 - p);
        }
        return cam;
      };

      // --- input & visibility ---
      const mouse = { x: 0, y: 0, cx: 0, cy: 0 };
      this._mm = e => { mouse.x = e.clientX / innerWidth - .5; mouse.y = e.clientY / innerHeight - .5; };
      window.addEventListener('mousemove', this._mm);
      let vis = true; this._io = new IntersectionObserver(es => { vis = es[0].isIntersecting; }); this._io.observe(this);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

      const Lx = -.45, Ly = -.55, Lz = .7, Ll = Math.hypot(Lx, Ly, Lz);
      let tAbs = 0, genStart = 0;

      const frame = rdt => {
        alloc();
        const dt = rdt / SLOW; tAbs += dt;
        while (tAbs - genStart >= T_GEN) { genStart += T_GEN; inherit(); spawn(genStart); }
        const tg = tAbs - genStart;
        const km = 1 - Math.exp(-rdt * .9); mouse.cx += (mouse.x - mouse.cx) * km; mouse.cy += (mouse.y - mouse.cy) * km;

        const cam = camera(tg, tAbs);
        const yaw = cam.yaw + mouse.cx * .35, pit = cam.pit + mouse.cy * .15, roll = -.14;
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit), cr = Math.cos(roll), sr = Math.sin(roll);
        const F = Hc * .5 / Math.tan(15 * PI / 180) * ZOOM * cam.zoom, HX = Wc / 2, HY = Hc / 2;
        const SA0 = fit(SHAPES[species](tAbs)), SB0 = tg >= T_EVOLVE ? fit(SHAPES[(species + 1) % NS](tAbs)) : SA0;
        // pre-division budding: surface lumps swell and recede, peaking as the split begins
        const buds = [];
        const bAmp = tg < T_SPLIT ? .6 + .4 * tg / T_SPLIT : tg < T_EVOLVE ? 1 - sm((tg - T_SPLIT) / (SEG.split * .6)) : 0;
        let nz = 0; while (nz < M && SA0[nz][3] > 0) nz++;
        for (let b = 0; b < NB; b++) {
          if (bAmp <= 0 || !nz) { buds.push([0, 0, 0, 0]); continue; }
          const A = SA0[Math.floor(BUDA[b][0] * nz)], L = Math.hypot(A[0], A[1], A[2]) || 1;
          const pulse = bAmp * Math.pow(Math.max(0, Math.sin(tAbs * 1.7 * BUDA[b][1] + BUDA[b][2])), 2);
          buds.push([A[0] + A[0] / L * A[3] * .95 * pulse, A[1] + A[1] / L * A[3] * .95 * pulse, A[2] + A[2] / L * A[3] * .95 * pulse, A[3] * .62 * pulse]);
        }
        const SA = SA0.concat(buds), SB = SB0.concat(buds);
        const t0 = performance.now();
        fld.fill(0);

        for (let j = -1; j < NI; j++) {
          if (performance.now() - t0 > 150) break;
          const o = pose(j, tg);
          if (o.hide || o.dis >= .999) continue;
          const isP = j < 0, K = isP ? null : kids[j];
          const MJ = isP ? PM : K.mut, pxj = isP ? PPX : lerp(PPX, K.px, o.mu), pyj = isP ? PPY : lerp(PPY, K.py, o.mu);
          const ps = PSO + (isP ? 0 : K.face * o.mu), cf = Math.cos(ps), sf = Math.sin(ps);
          for (let i = 0; i < MM; i++) {
            const q = sm((o.k - delay[i] * .2) / .8), A = SA[i], B = SB[i], bul = Math.sin(q * PI);
            let x = lerp(A[0], B[0], q), y = lerp(A[1], B[1], q), z = lerp(A[2], B[2], q), r = lerp(A[3], B[3], q);
            if (bul > 0) { r *= 1 + bul * .2; y += Math.sin(i * 1.7 + tAbs + j) * bul * .1; }
            const pm = i < M ? PM[i] : 1; r *= isP ? pm : lerp(pm, i < M ? MJ[i] : 1, o.mu); x *= pxj; y *= pyj;
            if (K && K.warp) { const wa = K.warp[0] * o.mu * (.35 + .65 * o.k); x += Math.sin(y * K.warp[1] + K.warp[2]) * wa; z += Math.cos(x * K.warp[1] * .8 + K.warp[2]) * wa * .6; y += Math.sin(x * K.warp[1] * .6 + K.warp[2] * 1.3) * wa * .5; }
            if (o.dis > 0) { r *= Math.pow(1 - o.dis, 1.1); y -= o.dis * o.dis * (1.4 + DR[i] * 1.8); }
            x *= o.scl; y *= o.scl; z *= o.scl; r *= o.scl;
            if (!(r > .002)) continue;
            { const x1 = x * cf - z * sf; z = x * sf + z * cf; x = x1; }
            x += o.x - cam.tx; z += o.z - cam.tz; y += o.y;
            const xr = x * cy - z * sy, zr = x * sy + z * cy, yr = y * cp - zr * sp, zz = y * sp + zr * cp;
            const dz = D - zz; if (!(dz > 1)) continue;
            const w = F / dz, sx = HX + (xr * cr - yr * sr) * w, sY = HY - (xr * sr + yr * cr) * w, R = Math.min(Hc * .5, r * w * KR), R2 = R * R;
            if (!(R > .3) || !(sx > -R && sx < Wc + R && sY > -R && sY < Hc + R)) continue;
            const x0 = Math.max(1, Math.floor(sx - R)), x1 = Math.min(Wc - 2, Math.ceil(sx + R)), y0 = Math.max(1, Math.floor(sY - R)), y1 = Math.min(Hc - 2, Math.ceil(sY + R));
            for (let yy = y0; yy <= y1; yy++) { const dy = yy - sY, row = yy * Wc; for (let xx = x0; xx <= x1; xx++) { const dx = xx - sx, d2 = (dx * dx + dy * dy) / R2; if (d2 < 1) { const u = 1 - d2; fld[row + xx] += u * u * u * o.w; } } }
          }
        }

        for (let yy = 1; yy < Hc - 1; yy++) {
          const br = (yy & 3) * 4, row = yy * Wc;
          for (let xx = 1; xx < Wc - 1; xx++) {
            const p = row + xx, f = fld[p];
            if (f < TH) { px[p * 4 + 3] = 0; continue; }
            const nx = -(fld[p + 1] - fld[p - 1]) * 2.2, ny = -(fld[p + Wc] - fld[p - Wc]) * 2.2, nl = Math.hypot(nx, ny, 1);
            const diff = Math.max(0, (nx * Lx + ny * Ly + Lz) / (nl * Ll));
            let tone = .08 + .82 * Math.pow(1 - diff, 1.4);
            const edge = 1 - Math.min(1, (f - TH) / (TH * .9));
            if (edge > tone) tone = edge * .95;
            px[p * 4 + 3] = tone > BAYER[br + (xx & 3)] ? 255 : 0;
          }
        }
        ctx.putImageData(img, 0, 0);

        if (probeN < 150) { probeT += performance.now() - t0; if (++probeN % 50 === 0) { if (probeT / 50 > 14 && res > 72) res = Math.round(res * .75); probeT = 0; } }
      };

      let last = 0;
      const loop = now => {
        if (this._dead) return;
        this._raf = requestAnimationFrame(loop);
        const raw = now - last; last = now;
        if (!vis || document.hidden) return;
        try { frame(Math.min(.05, raw / 1000)); } catch (err) { if (!this._errd) { this._errd = true; console.error('rq-blob', err); } }
      };
      const start = () => {
        if (this._dead) return;
        if (reduce) { species = NS - 1; frame(.016); return; }
        last = performance.now(); this._raf = requestAnimationFrame(loop);
      };
      if (document.readyState === 'complete') setTimeout(start, 100); else window.addEventListener('load', () => setTimeout(start, 100), { once: true });
    }
    disconnectedCallback() { setTimeout(() => { if (this.isConnected) return; this._dead = true; cancelAnimationFrame(this._raf); this._io && this._io.disconnect(); window.removeEventListener('mousemove', this._mm); }, 0); }
  }
  customElements.define('rq-blob', RqBlob);
})();
