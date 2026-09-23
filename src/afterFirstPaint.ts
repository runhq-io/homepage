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

export function afterFirstPaint(fn: () => void): void {
  if (painted || typeof window.requestAnimationFrame !== 'function') {
    painted = true;
    whenIdle(fn);
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      painted = true;
      whenIdle(fn);
    }, 0);
  });
}
