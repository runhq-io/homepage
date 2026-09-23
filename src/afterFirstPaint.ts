/**
 * Run work after the page's first paint, when the main thread is next idle.
 *
 * The RunHQ SDK (widget.js) is ~230 kB compressed and a long parse; nothing a
 * visitor sees at first paint depends on it (R114: the copy is decided from
 * the boot config), so it must not compete with the app bundle or the first
 * render (R115). `requestAnimationFrame` runs just before the next paint; the
 * task queued from it runs after that paint. Then idle time, bounded so a busy
 * page still loads the SDK promptly (a consented visitor's queued exposure
 * waits for it).
 */
const IDLE_TIMEOUT_MS = 1000;

let painted = false;

function whenIdle(fn: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric.call(window, fn, { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(fn, 0);
}

/**
 * `idle: false` skips the idle wait: for a visitor whose stored consent is
 * granted the SDK is what sends their exposures (R126), so it starts right
 * after the paint — but never during React's first render, which cost those
 * visitors 2–4 s of hero image when it did (round-2 re-review I-1).
 */
export function afterFirstPaint(fn: () => void, options: { idle?: boolean } = {}): void {
  const next = options.idle === false ? fn : () => whenIdle(fn);
  if (painted || typeof window.requestAnimationFrame !== 'function') {
    painted = true;
    if (options.idle === false) window.setTimeout(fn, 0);
    else whenIdle(fn);
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      painted = true;
      next();
    }, 0);
  });
}
