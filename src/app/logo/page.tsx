'use client';

import { useCallback, useRef, useState } from 'react';
import { MercuryMark } from '@/components/MercuryMark';

const SIZE = 512;
const DARK_BG = '#0a0a0f';

type SnapState = 'idle' | 'saved' | 'error';

export default function LogoPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<SnapState>('idle');

  const handleSnapshot = useCallback(async () => {
    const stage = stageRef.current;
    const liveSvg = stage?.querySelector('svg');
    if (!liveSvg) {
      setSnap('error');
      return;
    }

    let svgUrl: string | undefined;
    let pngUrl: string | undefined;
    try {
      // Clone the live SVG so we can freeze its animation without disturbing
      // what the user sees on screen.
      const clone = liveSvg.cloneNode(true) as SVGSVGElement;

      // Bake the *current* frame: copy each animated element's computed
      // transform (and the specular's opacity) onto the clone as inline styles,
      // then disable animation so serialization captures this exact frame
      // rather than the 0% keyframe.
      const liveNodes = liveSvg.querySelectorAll<SVGElement>(
        '.lm-merc-base, .lm-merc-bulge, .lm-merc-tint, .lm-merc-spec',
      );
      const cloneNodes = clone.querySelectorAll<SVGElement>(
        '.lm-merc-base, .lm-merc-bulge, .lm-merc-tint, .lm-merc-spec',
      );
      liveNodes.forEach((live, i) => {
        const target = cloneNodes[i];
        if (!target) return;
        const cs = getComputedStyle(live);
        target.style.transform = cs.transform === 'none' ? '' : cs.transform;
        target.style.transformOrigin = cs.transformOrigin;
        target.style.opacity = cs.opacity;
        target.style.animation = 'none';
      });

      // Explicit dimensions + namespace so the standalone serialized SVG
      // rasterizes at the intended resolution.
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(SIZE));
      clone.setAttribute('height', String(SIZE));

      const svgText = new XMLSerializer().serializeToString(clone);
      svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));

      const img = new Image();
      img.width = SIZE;
      img.height = SIZE;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('SVG image failed to load'));
        img.src = svgUrl as string;
      });

      const canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      ctx.fillStyle = DARK_BG;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.drawImage(img, 0, 0, SIZE, SIZE);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!blob) throw new Error('Canvas export failed');

      pngUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = 'runhq-logo.png';
      document.body.appendChild(a);
      a.click();
      a.remove();

      setSnap('saved');
    } catch (err) {
      console.error('[logo] snapshot failed', err);
      setSnap('error');
    } finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
      if (pngUrl) URL.revokeObjectURL(pngUrl);
      // Reset the button label after a beat.
      window.setTimeout(() => setSnap('idle'), 2200);
    }
  }, []);

  const label =
    snap === 'saved' ? 'Saved ✓' : snap === 'error' ? "Couldn't capture" : 'Snapshot PNG';

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center gap-10 px-4"
      style={{ background: DARK_BG }}
    >
      <div
        ref={stageRef}
        style={{ width: SIZE, height: SIZE }}
        className="flex items-center justify-center"
      >
        <MercuryMark size={SIZE} />
      </div>

      <button
        type="button"
        onClick={handleSnapshot}
        className="rounded-lg border border-white/15 bg-white/5 px-6 py-3 text-sm font-medium text-white/90 transition-colors hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/30"
      >
        {label}
      </button>
    </main>
  );
}
