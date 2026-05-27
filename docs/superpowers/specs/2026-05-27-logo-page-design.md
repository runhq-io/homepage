# `/logo` page — large animated Mercury mark with PNG snapshot

**Date:** 2026-05-27
**Status:** Approved

## Goal

A public `/logo` page that renders the RunHQ "Mercury" liquid-metal brand mark
(currently a 26×26 launcher icon in `public/widget.js`) at a fixed **512×512**,
on a **dark** background, with a **Snapshot** button that captures the current
animation frame and downloads it as a PNG.

## Context

The mark lives in `public/widget.js` (`buildTabIcon`, lines ~942–1008, with CSS
keyframes ~1284–1387). It is an SVG composed of:

- A goo filter (`feGaussianBlur` stdDeviation 3.4 + alpha-threshold
  `feColorMatrix`) so a base circle and six orbiting bulges fuse into a
  rippling liquid silhouette.
- Four radial gradients: pearlescent fill, specular, cyan rim, violet rim.
- An inner clip path (`r=22`) for the rim and specular layers.
- A `mix-blend-mode: screen` group for the iridescent cyan/violet rim.
- A roaming specular highlight.

All motion is CSS-keyframe driven; `prefers-reduced-motion` freezes it.

The keyframe translate values and `transform-origin: 40px 40px` are expressed in
the SVG's **80×80 viewBox user units** (CSS transforms on SVG elements operate in
local user space), so rendering the same SVG into a 512×512 box scales all motion
proportionally with **no keyframe changes**.

## Files

- **`src/components/MercuryMark.tsx`** *(new)* — reusable React port of the SVG.
  Props: `size?: number` (default 512). Carries its own scoped CSS keyframes via
  an embedded `<style>` element, classes namespaced `lm-*` (NOT the widget's
  `rw-*`) to avoid collision. Includes the `prefers-reduced-motion` freeze.
  Presentational only.
- **`src/app/logo/page.tsx`** *(new)* — `"use client"`. Full-viewport dark page,
  `<MercuryMark size={512} />` centered, plus a **Snapshot** button. Owns the
  capture-to-PNG logic.
- **`src/middleware.ts`** *(edit)* — add `/logo` (and `/logo/`) to the public
  page allowlist so it is reachable without auth (no `/login` redirect).

## Snapshot → PNG (dependency-free, exact current frame)

1. Deep-clone the live `<svg>` node.
2. For each animated element, read the **live** element's
   `getComputedStyle().transform` (matrix) — plus `opacity` for the specular —
   and bake them as inline styles on the matching clone node, setting
   `animation: none`. This freezes the current frame rather than the 0% keyframe.
3. Set explicit `width`/`height` = 512 and `xmlns` on the clone; serialize with
   `XMLSerializer`.
4. Load the serialized SVG (Blob URL) into an `Image`; draw a dark background
   rect + the image onto a 512×512 `<canvas>`.
5. `canvas.toBlob('image/png')` → trigger an anchor download as
   `runhq-logo.png`; revoke object URLs.

All content is inline (gradients/filter in `<defs>`, no external fonts/images),
so the canvas never taints and `toBlob` succeeds.

## Edge cases

- **SSR**: page is `"use client"`; capture runs only on click — no `window` use
  at module/render time.
- **Capture failure**: wrapped in try/catch; button shows transient
  "Saved ✓" / "Couldn't capture" state, never hangs.
- **`mix-blend-mode: screen`** kept as an inline `style` attribute so it survives
  serialization into the rasterized PNG.
- **Reduced motion**: capture yields the intended frozen static mark.

## Out of scope

- Wordmark/tagline (chose mark-only).
- Responsive sizing (chose fixed 512×512).
- Transparent/light backgrounds (chose dark).
