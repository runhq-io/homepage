/**
 * Evolve surfaces on the marketing site: the copy a section renders.
 *
 * The copy is decided SYNCHRONOUSLY from the page's boot config (bootConfig.ts)
 * and the shared assignment block (evolveAssign.js) — never by waiting for the
 * SDK script, which loads after first paint (ruling R114):
 *   - No consent (or no id the SDK could count): the ADOPTED copy — a promoted
 *     winner, or a live run's control — else the shipped copy. Never an arm,
 *     nothing recorded (R4).
 *   - Consent + the SDK's visitor id (visitorId.ts; minted under the SDK's key
 *     when absent): the arm the shared block picks, painted at once. Its
 *     exposure (and the surface's declaration) is queued when the block is
 *     first SEEN (R127: SurfaceBlock's IntersectionObserver calls `seen`), and
 *     leaves the page through the SDK or, if the visitor goes first, the
 *     page's own beacon (bootConfig `armExposureBeacon`, R126).
 *   - The config still in flight at first render: the block is laid out
 *     invisibly (SurfaceBlock) and waits for the CONFIG, at most
 *     SURFACE_WAIT_MS from when the page asked for it, judged by when the
 *     answer ARRIVED (bootConfig `arrival`), not by a timer a busy main thread
 *     cannot fire. Past that, the shipped copy paints and never swaps; a
 *     consented read that ends there is reported (`evolve_surface_timeout`).
 *   - Consent granted by the Accept on THIS page (R18/R19): a block already
 *     seen is assigned at once, in the same task as the Accept, so the swap is
 *     the direct result of the visitor's input. A block not yet seen, and
 *     every block when consent arrives from another tab (no input here to
 *     excuse a shift), keeps its copy until its next mount.
 *   - A tracked read is LATCHED for the page load: a later mount (SPA
 *     navigation back home) gets the same copy and queues nothing more.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { loadWidgetScript } from '../widget';
import { telemetryConsented, trackEvent } from '../telemetry';
import { CONSENT_EVENT, CONSENT_KEY } from '../analytics';
import {
  currentBoot,
  flushRendersToOlderSdk,
  type EvolveBootHandle,
  type RenderEntry,
  type ServedArm,
  type ServedRun,
  type ServingConfig,
} from './bootConfig';
import { evolveAssign } from './evolveAssign.js';
import { ensureVisitorId, readVisitorId, trackingSuppressed } from './visitorId';

/** The longest a surface stays invisible waiting for the boot config, from when the page asked for it. */
export const SURFACE_WAIT_MS = 400;

/** The event a consented read that missed the config records (ruling R45). */
export const SURFACE_TIMEOUT_EVENT = 'evolve_surface_timeout';

export type SurfaceFields = Readonly<Record<string, string>>;

export interface SurfaceSnapshot<T extends SurfaceFields> {
  readonly value: T;
  /** False only while waiting for the config: the block is laid out but invisible. */
  readonly settled: boolean;
}

export interface SurfaceEnv {
  consentGranted(): boolean;
  /**
   * Calls `listener` whenever the stored consent may have changed — `page`: this
   * page's consent bar (an input); `other-tab`: another tab's; returns an unsubscribe.
   */
  onConsentChange(listener: (source: 'page' | 'other-tab') => void): () => void;
  /** This page load's boot config, or null when none was started. */
  boot(): EvolveBootHandle | null;
  /**
   * Consented visitors only: the SDK's visitor id (minted under its key when
   * absent), or null when the SDK could not count this visitor (its tracker is
   * suppressed, or storage cannot keep an id).
   */
  visitorId(): string | null;
  /** A viewer-forced arm's NAME for the surface, or null. */
  forcedArm(surfaceKey: string): string | null;
  setTimeout(fn: () => void, ms: number): unknown;
  /** A consented read missed the config: recorded (R45) so the unmeasured share is visible. */
  reportTimeout(surfaceKey: string): void;
  /** Hand a render to the SDK (the boot queue). */
  queueRender(entry: RenderEntry): void;
}

export interface SurfaceStore {
  read<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceSnapshot<T>;
  subscribe(surfaceKey: string, listener: () => void): () => void;
  /** The mounted block was first seen (its top edge entered the upper 75% of the viewport). */
  seen(surfaceKey: string): void;
}

/**
 * A payload laid over the shipped copy, field by field. A model-written payload
 * may omit a field, blank it, or carry the wrong type; each such field renders
 * its shipped copy. Fields the copy does not have are ignored. Returns the
 * fallback object itself when nothing differs, so snapshots stay stable.
 */
export function mergeFields<T extends SurfaceFields>(payload: unknown, fallback: T): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  const source = payload as Record<string, unknown>;
  const merged: Record<string, string> = {};
  let changed = false;
  for (const field of Object.keys(fallback)) {
    const candidate = source[field];
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      merged[field] = candidate;
      if (candidate !== fallback[field]) changed = true;
    } else {
      merged[field] = fallback[field];
    }
  }
  return changed ? (merged as unknown as T) : fallback;
}

function sameFields(a: SurfaceFields, b: SurfaceFields): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * - `waiting`: first read made while the config is in flight; invisible.
 * - `untracked`: painted with no assignment; may be assigned on consent.
 * - `latched`: settled with the tracker's id (or past the cap); final.
 */
type EntryState = 'waiting' | 'untracked' | 'latched';

interface Entry {
  state: EntryState;
  snapshot: SurfaceSnapshot<SurfaceFields>;
  readonly fallback: SurfaceFields;
  readonly listeners: Set<() => void>;
  /** A render not yet handed over: handed over once the block has been seen. */
  render: RenderEntry | null;
  /** This mount of the block has been seen. Reset when it unmounts. */
  seen: boolean;
}

interface Decision {
  value: SurfaceFields;
  state: 'untracked' | 'latched';
  render: RenderEntry | null;
}

/** By name only, exactly as widget.js `evolveResolve` forces (re-review m2). */
function forcedIn(run: ServedRun | null | undefined, forced: string | null): ServedArm | null {
  if (!run || !forced) return null;
  return run.arms.find((a) => a.name === forced) ?? null;
}

export function createSurfaceStore(env: SurfaceEnv): SurfaceStore {
  const entries = new Map<string, Entry>();
  let watchingConsent = false;

  /**
   * What `surfaceKey` shows now. `config` null with `timedOut` = the config
   * missed the cap; null without it = there is none to be had.
   */
  function decide(surfaceKey: string, fallback: SurfaceFields, config: ServingConfig | null, timedOut: boolean): Decision {
    const served = config?.surfaces[surfaceKey];
    const forced = forcedIn(served?.run, env.forcedArm(surfaceKey));
    const subjectKey = env.consentGranted() ? env.visitorId() : null;
    if (!subjectKey) {
      return { value: mergeFields(forced ? forced.payload : served?.adopted, fallback), state: 'untracked', render: null };
    }
    if (timedOut) {
      try {
        env.reportTimeout(surfaceKey);
      } catch {
        // Measurement never decides what the page renders.
      }
    }
    const declaration: RenderEntry = { surfaceKey, defaultPayload: fallback, subjectKey };
    const liveRun = served?.run;
    if (liveRun) {
      const variationId = forced ? forced.variationId : evolveAssign(liveRun, subjectKey);
      const arm = liveRun.arms.find((a) => a.variationId === variationId);
      if (arm) {
        return {
          value: mergeFields(arm.payload, fallback),
          state: 'latched',
          render: { ...declaration, experimentId: liveRun.experimentId, epoch: liveRun.epoch, variationId: arm.variationId, override: forced !== null },
        };
      }
    }
    return { value: mergeFields(served?.adopted, fallback), state: 'latched', render: declaration };
  }

  function handOver(entry: Entry): void {
    if (!entry.render || !entry.seen) return;
    const render: RenderEntry = { ...entry.render, ts: Date.now() };
    entry.render = null;
    try {
      env.queueRender(render);
    } catch {
      // As above.
    }
  }

  /** Apply a decision; a new snapshot only when the copy or its settledness changed. */
  function apply(entry: Entry, decision: Decision): void {
    entry.state = decision.state;
    entry.render = decision.render;
    const current = entry.snapshot;
    if (!current.settled || !sameFields(current.value, decision.value)) {
      entry.snapshot = { value: decision.value, settled: true };
    }
    handOver(entry);
  }

  function publish(entry: Entry): void {
    for (const listener of [...entry.listeners]) listener();
  }

  /** Decide now from whatever the boot holds: its config, or nothing. */
  function decideSettled(surfaceKey: string, entry: Entry, boot: EvolveBootHandle | null): void {
    apply(entry, decide(surfaceKey, entry.fallback, boot?.config() ?? null, false));
  }

  /** The config is in flight: wait for it, invisibly, up to the cap. */
  function awaitConfig(surfaceKey: string, entry: Entry, boot: EvolveBootHandle): void {
    entry.state = 'waiting';
    const conclude = (config: ServingConfig | null, timedOut: boolean) => {
      if (entry.state !== 'waiting') return;
      apply(entry, decide(surfaceKey, entry.fallback, config, timedOut));
      publish(entry);
    };
    boot.onSettle(() => {
      const arrival = boot.arrival();
      if (arrival !== null && arrival <= SURFACE_WAIT_MS) conclude(boot.config(), false);
      else conclude(null, true);
    });
    env.setTimeout(() => {
      const arrival = boot.arrival();
      // It arrived in time and its callback is merely queued behind a busy
      // thread: that callback decides, with the config.
      if (arrival !== null && arrival <= SURFACE_WAIT_MS) return;
      conclude(null, true);
    }, Math.max(0, SURFACE_WAIT_MS - boot.elapsed()));
  }

  function firstRead(surfaceKey: string, entry: Entry): void {
    const boot = env.boot();
    if (!boot || boot.settled()) return decideSettled(surfaceKey, entry, boot);
    const arrival = boot.arrival();
    if (arrival !== null) {
      if (arrival <= SURFACE_WAIT_MS) return awaitConfig(surfaceKey, entry, boot);
      return apply(entry, decide(surfaceKey, entry.fallback, null, true));
    }
    if (boot.elapsed() >= SURFACE_WAIT_MS) return apply(entry, decide(surfaceKey, entry.fallback, null, true));
    awaitConfig(surfaceKey, entry, boot);
  }

  /** Assign an untracked surface now, if the visitor has consented and the config is here. */
  function assignIfConsented(surfaceKey: string, entry: Entry): boolean {
    if (!env.consentGranted()) return false;
    const boot = env.boot();
    if (boot && !boot.settled()) return false;
    const decision = decide(surfaceKey, entry.fallback, boot?.config() ?? null, false);
    if (decision.state !== 'latched') return false;
    apply(entry, decision);
    return true;
  }

  function onConsentChange(source: 'page' | 'other-tab'): void {
    // Only this page's Accept is an input that may change what is on screen.
    if (source !== 'page' || !env.consentGranted()) return;
    for (const [surfaceKey, entry] of entries) {
      // Only blocks the visitor has seen are assigned now; the rest keep their
      // copy until their next mount, so nothing swaps as it scrolls into view.
      if (entry.state === 'untracked' && entry.seen && entry.listeners.size > 0 && assignIfConsented(surfaceKey, entry)) publish(entry);
    }
  }

  return {
    read<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceSnapshot<T> {
      const existing = entries.get(surfaceKey);
      if (existing) {
        if (existing.state === 'untracked') {
          if (existing.listeners.size > 0) {
            // Mounted: nothing but this page's Accept swaps a painted block.
          } else {
            // A new mount: decided afresh, from whatever the config now says.
            decideSettled(surfaceKey, existing, env.boot()?.settled() ? env.boot() : null);
          }
        }
        return existing.snapshot as SurfaceSnapshot<T>;
      }
      const entry: Entry = { state: 'waiting', snapshot: { value: fallback, settled: false }, fallback, listeners: new Set(), render: null, seen: false };
      entries.set(surfaceKey, entry);
      firstRead(surfaceKey, entry);
      return entry.snapshot as SurfaceSnapshot<T>;
    },
    subscribe(surfaceKey: string, listener: () => void): () => void {
      // Armed on first use, not at import: importing this module must not touch `window`.
      if (!watchingConsent) {
        watchingConsent = true;
        env.onConsentChange(onConsentChange);
      }
      const entry = entries.get(surfaceKey);
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        // Unmounted: the next mount must be seen again.
        if (entry.listeners.size === 0) entry.seen = false;
      };
    },
    seen(surfaceKey: string): void {
      const entry = entries.get(surfaceKey);
      if (!entry || entry.seen) return;
      entry.seen = true;
      handOver(entry);
    },
  };
}

/** Same signals RunHQWidget's useConsent reads: this tab's consent bar, and other tabs. */
function watchBrowserConsent(listener: (source: 'page' | 'other-tab') => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === CONSENT_KEY) listener('other-tab');
  };
  const onPage = () => listener('page');
  window.addEventListener(CONSENT_EVENT, onPage);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onPage);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The SDK's viewer override (`?runhq_variation=<surface>:<arm name>`, remembered for
 * the tab under `rw_evolve_override`), read the way widget.js
 * `evolveLoadOverrides` reads it. Read-only: the SDK owns the stored value.
 */
export function browserForcedArm(surfaceKey: string): string | null {
  try {
    let stored: Record<string, string> = {};
    try {
      const raw = sessionStorage.getItem('rw_evolve_override');
      if (raw) stored = JSON.parse(raw) as Record<string, string>;
    } catch {
      stored = {};
    }
    const requested = new URLSearchParams(window.location.search || '').get('runhq_variation');
    if (requested === 'off') return null;
    if (requested) {
      const parts = requested.split(':');
      if (parts.length === 2) stored = { ...stored, [parts[0]]: parts[1] };
    }
    const forced = stored[surfaceKey];
    return typeof forced === 'string' && forced ? forced : null;
  } catch {
    return null;
  }
}

let olderSdkFlushArmed = false;

/**
 * Hand a render to the SDK. The SDK takes the boot queue when its tracker
 * starts; one that predates the queue is handed each render through
 * `variation()` once it is ready (R118). Either way the SDK loads after first
 * paint (widget.ts `loadWidgetScript`).
 */
function browserQueueRender(entry: RenderEntry): void {
  const boot = currentBoot();
  if (!boot) return;
  boot.queueRender(entry);
  if (olderSdkFlushArmed) return;
  olderSdkFlushArmed = true;
  loadWidgetScript(() => {
    const sdk = window.RunHQWidget;
    const ready = sdk?.ready;
    const variation = sdk?.variation;
    if (!sdk || typeof ready !== 'function' || typeof variation !== 'function') return;
    ready.call(sdk).then(
      () => flushRendersToOlderSdk(boot, { variation: (k, f) => variation.call(sdk, k, f) }, readVisitorId()),
      () => {},
    );
  });
}

export const surfaceStore: SurfaceStore = createSurfaceStore({
  consentGranted: telemetryConsented,
  onConsentChange: watchBrowserConsent,
  boot: currentBoot,
  visitorId: () => (trackingSuppressed() ? null : ensureVisitorId()),
  forcedArm: browserForcedArm,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  // Consent-gated, guarded, and queued by the SDK until its tracker starts.
  reportTimeout: (surfaceKey) => trackEvent(SURFACE_TIMEOUT_EVENT, { surface: surfaceKey }),
  queueRender: browserQueueRender,
});

export interface SurfaceView<T extends SurfaceFields> extends SurfaceSnapshot<T> {
  /** Hand to the block's SurfaceBlock `onSeen`: it calls this once the block is first seen. */
  readonly seen: () => void;
}

/**
 * The copy for an Evolve surface. `fallback` must be a stable object (a module
 * constant): it is the shipped copy and the surface's declared default.
 */
export function useSurface<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceView<T> {
  const subscribe = useCallback((listener: () => void) => surfaceStore.subscribe(surfaceKey, listener), [surfaceKey]);
  const snapshot = useSyncExternalStore(subscribe, () => surfaceStore.read(surfaceKey, fallback));
  const seen = useCallback(() => surfaceStore.seen(surfaceKey), [surfaceKey]);
  return useMemo(() => ({ ...snapshot, seen }), [snapshot, seen]);
}
