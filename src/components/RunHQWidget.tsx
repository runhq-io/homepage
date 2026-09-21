import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { RUNHQ_PROJECT, isBoardRoute, loadWidgetScript, removeWidgetHost } from '../widget';
import { CONSENT_EVENT, CONSENT_KEY, storedConsent, type ConsentValue } from '../analytics';
import { clearTelemetryIdentifiers, shouldTrack, widgetInitOptions } from '../telemetry';

/**
 * Mounts the floating RunHQ widget launcher on the marketing site so any
 * visitor — or a recognised RunHQ member — can file RunHQ bugs against the
 * `runhq` board. Rendered once, globally, inside the router (see App.tsx).
 *
 * Identity: `useCookieAuth` lets the visitor's same-site `rw_session` cookie
 * flow on the widget's credentialed calls, so RunHQ members post as themselves
 * and everyone else gets the public/anonymous board — same model as the
 * full-page board (see BoardPage).
 *
 * Telemetry: this launcher is also what starts RunHQ's own tracker for the
 * `runhq` project, because the SDK's tracking half rides on the same `init()`.
 * It runs only once the visitor has accepted analytics — see telemetry.ts for
 * why consent governs it, and `shouldTrack` for why the board surface never
 * tracks.
 *
 * Coexistence with the full-page board: the widget script enforces one instance
 * per page. On a `/:slug` board route BoardPage owns that instance (standalone,
 * full-viewport), so the launcher stays out entirely there. On every other
 * route the launcher owns it. `init()` is idempotent, so marketing→marketing
 * navigation is a no-op that keeps the same bubble mounted.
 */
export default function RunHQWidget() {
  const { pathname } = useLocation();
  const consent = useConsent();

  useEffect(() => {
    // The board route mounts its own standalone widget; yield the single-widget
    // slot to it and don't paint a launcher on top. Forget what we knew about
    // the mounted instance while we do: BoardPage tears the host down on both
    // sides of its lifetime, so on the way back there is nothing of ours left
    // to upgrade — and believing otherwise would leave `attempt` below waiting
    // for a host that is never coming, and no launcher on the page.
    if (isBoardRoute(pathname)) {
      mountedWithTracking = null;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let attemptsLeft = HOST_WAIT_ATTEMPTS;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    // Returns false only when the attempt must be retried (see below).
    const attempt = (): boolean => {
      if (cancelled) return true;
      const track = shouldTrack(consent, 'marketing');
      const mounted = document.querySelector('runhq-widget-host') !== null;

      const action = launcherAction(mountedWithTracking, mounted, track);
      if (action === 'wait') return false;
      if (action === 'rebuild') removeWidgetHost();

      mountedWithTracking = track;
      try {
        window.RunHQWidget?.init(
          widgetInitOptions({ project: RUNHQ_PROJECT, surface: 'marketing', consent }),
        );
      } catch {
        // init() is idempotent — a redundant call (e.g. React 18 StrictMode's
        // double-invoke, or SPA re-navigation) is a no-op.
      }
      return true;
    };

    loadWidgetScript(() => {
      if (cancelled || attempt()) return;
      timer = setInterval(() => {
        // Give up rather than poll forever: tracking then starts on the next
        // navigation instead, which is the same outcome one route change later.
        if (attempt() || --attemptsLeft <= 0) stop();
      }, HOST_WAIT_MS);
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [pathname, consent]);

  // A visitor who declines should have the tracker's identifiers taken away,
  // not merely stop accumulating them: the widget tracked everyone before
  // consent gated it, so a returning visitor can be carrying an id they never
  // agreed to.
  useEffect(() => {
    if (consent === 'denied') clearTelemetryIdentifiers();
  }, [consent]);

  // The widget injects its own fixed-position shadow-DOM host; nothing to render.
  return null;
}

/** How long to wait for an in-flight init() to settle before giving up. */
const HOST_WAIT_MS = 250;
const HOST_WAIT_ATTEMPTS = 20;

/**
 * What to do with an `init()` we are about to issue, given what is already on
 * the page. Pure, because this is the part with the sharp edges.
 *
 *  - `init`    — just call init(). Either nothing is mounted, or what is
 *                mounted already has the tracking state we want (init() is
 *                idempotent, so a redundant call is a no-op).
 *  - `rebuild` — release the host first. Tracking has to be switched ON, and
 *                the SDK decides that once, inside init(), with no way to start
 *                the tracker afterwards. Releasing the host is its documented
 *                handoff (see `removeWidgetHost`) and lets a fresh init() past
 *                the single-widget guard.
 *  - `wait`    — the instance we need to rebuild has not mounted yet, so an
 *                init() now would be swallowed. The SDK's guard is
 *                `initInFlight || host` and nothing a host page can call clears
 *                `initInFlight`: an init() issued in that gap is dropped as a
 *                duplicate and tracking would never start. The consent bar sits
 *                right there on load, so accepting during the bootstrap is an
 *                ordinary thing to do — wait for the host, then rebuild.
 *
 * Switching tracking OFF is deliberately just `init`: the SDK latches its
 * tracker "started" for the lifetime of the page, so a rebuild would churn the
 * widget without stopping anything. Withdrawal is handled by dropping the
 * stored identifiers, and takes full effect on the next page load.
 */
export function launcherAction(
  mountedWithTracking: boolean | null,
  hostPresent: boolean,
  track: boolean,
): 'init' | 'rebuild' | 'wait' {
  // Nothing of ours is on the page (or the board tore it down) — nothing to
  // upgrade, and nothing to wait for.
  if (mountedWithTracking === null) return 'init';
  if (!track || mountedWithTracking) return 'init';
  return hostPresent ? 'rebuild' : 'wait';
}

/**
 * Whether the mounted launcher was initialised with tracking on, or null when
 * this component has not mounted one (yet, or since the board took the slot).
 *
 * Module scope, not a ref: it describes the page's single widget instance,
 * which outlives this component across board↔marketing navigation.
 */
let mountedWithTracking: boolean | null = null;

/**
 * The visitor's stored analytics choice, kept live.
 *
 * Consent decides whether the tracker may run at all, and it can change while
 * the page is open: in this tab (the consent bar, which fires CONSENT_EVENT) or
 * in another one (the native 'storage' event). Re-reading on both is what lets
 * Accept start tracking without a reload.
 */
function useConsent(): ConsentValue | null {
  const [consent, setConsent] = useState<ConsentValue | null>(storedConsent);

  useEffect(() => {
    const sync = () => setConsent(storedConsent());
    // key === null is a storage.clear() — treat it as "might have been ours".
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === CONSENT_KEY) sync();
    };
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return consent;
}
