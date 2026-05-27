/**
 * MercuryMark — the RunHQ "Mercury" liquid-metal brand mark.
 *
 * A faithful React port of the launcher icon in `public/widget.js`
 * (`buildTabIcon`). A base circle plus six perimeter-orbiting bulges share one
 * SVG goo filter (Gaussian blur + alpha-threshold matrix) so the silhouette
 * ripples like real liquid mercury. Layered on top: an iridescent oil-slick rim
 * (cyan + violet glows orbiting at offset phases, screen-blended) and an inner
 * roaming specular highlight.
 *
 * All motion is CSS-keyframe driven, so `prefers-reduced-motion` freezes it.
 * Every keyframe translate and `transform-origin` is expressed in the 80×80
 * viewBox's user units — CSS transforms on SVG elements operate in local user
 * space — so the mark scales to any rendered `size` with motion intact and no
 * keyframe changes.
 *
 * Classes are namespaced `lm-*` to stay isolated from the widget's `rw-*`
 * styles when both happen to share a page.
 */

const KEYFRAME_CSS = `
.lm-merc-blob { width: 100%; height: 100%; position: relative; border-radius: 50%; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.28)); }
.lm-merc-blob > svg { display: block; width: 100%; height: 100%; overflow: visible; position: relative; z-index: 1; }

/* Base circle subtly breathes so the silhouette is never static. */
.lm-merc-base { transform-origin: 40px 40px; animation: lm-merc-base 5.4s ease-in-out infinite; }
@keyframes lm-merc-base { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }

/* Six bulges orbit at radii larger than the base circle, each with its own
   keyframe + duration so the motion never visibly repeats. */
.lm-merc-bulge { transform-origin: 40px 40px; }
.lm-mb1 { animation: lm-mb-a 3.6s ease-in-out infinite; }
.lm-mb2 { animation: lm-mb-b 4.4s ease-in-out infinite; }
.lm-mb3 { animation: lm-mb-c 3.2s ease-in-out infinite; }
.lm-mb4 { animation: lm-mb-d 4.0s ease-in-out infinite; }
.lm-mb5 { animation: lm-mb-e 3.8s ease-in-out infinite; }
.lm-mb6 { animation: lm-mb-f 4.6s ease-in-out infinite; }
@keyframes lm-mb-a {
  0%   { transform: translate(20px, -2px)   scale(1.15); }
  25%  { transform: translate(14px, 15px)   scale(0.95); }
  50%  { transform: translate(-17px, 11px)  scale(1.2); }
  75%  { transform: translate(-13px, -16px) scale(0.9); }
  100% { transform: translate(20px, -2px)   scale(1.15); }
}
@keyframes lm-mb-b {
  0%   { transform: translate(-18px, 10px) scale(1.0); }
  33%  { transform: translate(10px, -18px) scale(1.25); }
  66%  { transform: translate(17px, 14px)  scale(0.85); }
  100% { transform: translate(-18px, 10px) scale(1.0); }
}
@keyframes lm-mb-c {
  0%   { transform: translate(2px, -20px)  scale(1.1); }
  25%  { transform: translate(18px, -9px)  scale(0.9); }
  50%  { transform: translate(11px, 18px)  scale(1.2); }
  75%  { transform: translate(-19px, 6px)  scale(1.0); }
  100% { transform: translate(2px, -20px)  scale(1.1); }
}
@keyframes lm-mb-d {
  0%   { transform: translate(15px, -11px)  scale(1.05); }
  33%  { transform: translate(-15px, -10px) scale(1.15); }
  66%  { transform: translate(3px, 19px)    scale(0.95); }
  100% { transform: translate(15px, -11px)  scale(1.05); }
}
@keyframes lm-mb-e {
  0%   { transform: translate(-9px, -17px) scale(1.0); }
  50%  { transform: translate(9px, 17px)   scale(1.15); }
  100% { transform: translate(-9px, -17px) scale(1.0); }
}
@keyframes lm-mb-f {
  0%   { transform: translate(17px, 9px)   scale(0.95); }
  50%  { transform: translate(-17px, -9px) scale(1.2); }
  100% { transform: translate(17px, 9px)   scale(0.95); }
}

/* Iridescent oil-slick rim — cyan + violet glows orbit at opposing phases. */
.lm-merc-tint   { transform-origin: 40px 40px; }
.lm-merc-cyan   { animation: lm-merc-cyan   7.2s ease-in-out infinite; }
.lm-merc-violet { animation: lm-merc-violet 7.2s ease-in-out infinite; }
@keyframes lm-merc-cyan {
  0%   { transform: translate(-8px, -6px); }
  50%  { transform: translate(8px, 6px); }
  100% { transform: translate(-8px, -6px); }
}
@keyframes lm-merc-violet {
  0%   { transform: translate(8px, 6px); }
  50%  { transform: translate(-8px, -6px); }
  100% { transform: translate(8px, 6px); }
}

/* Inner roaming specular — the catch-light, drifts with a scale + opacity wobble. */
.lm-merc-spec { transform-origin: 40px 40px; animation: lm-merc-spec 6.4s ease-in-out infinite; filter: blur(0.4px); }
@keyframes lm-merc-spec {
  0%   { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }
  25%  { transform: translate(8px, -6px)  scale(1.2); opacity: 0.7; }
  50%  { transform: translate(7px, 7px)   scale(0.9); opacity: 0.95; }
  75%  { transform: translate(-8px, 6px)  scale(1.1); opacity: 0.7; }
  100% { transform: translate(-7px, -8px) scale(1);   opacity: 0.95; }
}

/* Reduced motion — freeze the organism. The static silhouette still reads as a brand mark. */
@media (prefers-reduced-motion: reduce) {
  .lm-merc-base, .lm-merc-bulge, .lm-merc-tint, .lm-merc-spec { animation: none !important; }
}
`;

export interface MercuryMarkProps {
  /** Rendered size in px (square). Motion is resolution-independent. */
  size?: number;
  className?: string;
}

export function MercuryMark({ size = 512, className }: MercuryMarkProps) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: size, height: size }}
      aria-hidden="true"
    >
      <style>{KEYFRAME_CSS}</style>
      <span className="lm-merc-blob">
        <svg viewBox="0 0 80 80" focusable="false" overflow="visible">
          <defs>
            <filter id="lm-merc-goo" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3.4" />
              <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11" />
            </filter>
            <radialGradient id="lm-merc-fill" cx="38%" cy="28%" r="80%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="30%" stopColor="#f4f0ff" />
              <stop offset="58%" stopColor="#cfd8ff" />
              <stop offset="82%" stopColor="#b9aaf0" />
              <stop offset="100%" stopColor="#7d6dc8" />
            </radialGradient>
            <radialGradient id="lm-merc-spec-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255,255,255,1)" />
              <stop offset="60%" stopColor="rgba(255,255,255,0.45)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </radialGradient>
            <radialGradient id="lm-merc-cyan-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(150,210,255,0.55)" />
              <stop offset="100%" stopColor="rgba(150,210,255,0)" />
            </radialGradient>
            <radialGradient id="lm-merc-violet-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(180,130,255,0.45)" />
              <stop offset="100%" stopColor="rgba(180,130,255,0)" />
            </radialGradient>
            <clipPath id="lm-merc-inner-clip" clipPathUnits="userSpaceOnUse">
              <circle cx="40" cy="40" r="22" />
            </clipPath>
          </defs>

          {/* Base + 6 bulges merge into a rippling liquid silhouette. */}
          <g filter="url(#lm-merc-goo)">
            <circle className="lm-merc-base" cx="40" cy="40" r="18" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb1" cx="40" cy="40" r="9" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb2" cx="40" cy="40" r="8" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb3" cx="40" cy="40" r="9.5" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb4" cx="40" cy="40" r="7.5" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb5" cx="40" cy="40" r="6.5" fill="url(#lm-merc-fill)" />
            <circle className="lm-merc-bulge lm-mb6" cx="40" cy="40" r="7" fill="url(#lm-merc-fill)" />
          </g>

          {/* Iridescent rim — cyan + violet glows orbit at offset phases. */}
          <g clipPath="url(#lm-merc-inner-clip)" style={{ mixBlendMode: 'screen' }}>
            <circle className="lm-merc-tint lm-merc-cyan" cx="40" cy="40" r="14" fill="url(#lm-merc-cyan-grad)" />
            <circle className="lm-merc-tint lm-merc-violet" cx="40" cy="40" r="14" fill="url(#lm-merc-violet-grad)" />
          </g>

          {/* Inner roaming specular highlight. */}
          <g clipPath="url(#lm-merc-inner-clip)">
            <circle className="lm-merc-spec" cx="40" cy="40" r="5" fill="url(#lm-merc-spec-grad)" />
          </g>
        </svg>
      </span>
    </span>
  );
}
