/**
 * Evolve surfaces on the marketing site: the copy a section renders.
 *
 * The rules (spec SP10, "Serving without flicker", amended by ruling R18):
 *   - A visitor who has not consented is never assigned (R4). Their read paints
 *     at once with what an unassignable visitor sees — the live run's control,
 *     an adopted winner, or the shipped copy (bootConfig `untrackedPayload`) —
 *     calls no `variation()`, and is NOT latched.
 *   - A read made with the tracker on is LATCHED for the page load: a later
 *     mount (SPA navigation back home) gets the same copy, and `variation()`
 *     runs once per surface.
 *   - Consent already granted at a surface's first read: wait for the SDK's arm
 *     for at most SURFACE_WAIT_MS, invisibly (SurfaceBlock), then paint.
 *   - Consent granted while a surface is ON SCREEN: re-read it with the tracker
 *     on at once; the painted copy stays visible until the arm replaces it
 *     (cap SURFACE_CONSENT_WAIT_MS). A surface OFF screen at that moment is
 *     re-read at its next mount — never in the background, because reading the
 *     arm IS the exposure (widget.js `evolveVariation`).
 *   - For the same reason a read abandoned at its cap never calls `variation()`:
 *     a visitor who never saw an arm is never counted in it.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { loadWidgetScript } from '../widget';
import { telemetryConsented, trackEvent } from '../telemetry';
import { CONSENT_EVENT, CONSENT_KEY } from '../analytics';
import { bootConfigSnapshot, untrackedPayload, type ServingConfig } from './bootConfig';

/** The longest a consented visitor's surface stays invisible waiting for its arm. */
export const SURFACE_WAIT_MS = 400;

/**
 * How long a surface the visitor is ALREADY looking at waits for its arm after
 * they accept analytics. Nothing is hidden meanwhile — this bounds how late a
 * swap may come, not how long copy is invisible. Longer than SURFACE_WAIT_MS
 * because the tracker starts only once the widget has been rebuilt with
 * tracking on (RunHQWidget.tsx `launcherAction`, polling every 250 ms) and the
 * SDK has fetched its config.
 */
export const SURFACE_CONSENT_WAIT_MS = 3000;

/** The event a tracked read that gave up at its cap records (ruling R45). */
export const SURFACE_TIMEOUT_EVENT = 'evolve_surface_timeout';

export type SurfaceFields = Readonly<Record<string, string>>;

export interface SurfaceSnapshot<T extends SurfaceFields> {
  readonly value: T;
  /** False only while a first read is pending: the block is laid out but invisible. */
  readonly settled: boolean;
}

/** The two SDK calls a surface read needs. */
export interface EvolveSdk {
  ready(): Promise<void>;
  variation(surfaceKey: string, fallback: unknown): unknown;
}

export interface SurfaceEnv {
  consentGranted(): boolean;
  /** Calls `listener` whenever the stored consent may have changed; returns an unsubscribe. */
  onConsentChange(listener: () => void): () => void;
  configSnapshot(): ServingConfig | null;
  /** The SDK once its script has loaded, or null when it lacks the Evolve half. */
  loadSdk(): Promise<EvolveSdk | null>;
  setTimeout(fn: () => void, ms: number): unknown;
  /**
   * A read made with the tracker on gave up at its cap: the visitor was never
   * assigned, so they are in no arm. Recorded (ruling R45) so the unmeasured
   * share of consented traffic is visible in Analytics instead of silent.
   */
  reportTimeout(surfaceKey: string): void;
}

export interface SurfaceStore {
  read<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceSnapshot<T>;
  subscribe(surfaceKey: string, listener: () => void): () => void;
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

/**
 * - `untracked`: read before consent; painted, not latched.
 * - `pending`: a read with the tracker on is in flight.
 * - `latched`: settled with the tracker on; final for the page load.
 */
type EntryState = 'untracked' | 'pending' | 'latched';

interface Entry {
  state: EntryState;
  snapshot: SurfaceSnapshot<SurfaceFields>;
  readonly fallback: SurfaceFields;
  readonly listeners: Set<() => void>;
}

export function createSurfaceStore(env: SurfaceEnv): SurfaceStore {
  const entries = new Map<string, Entry>();
  /** Surfaces already reported as timed out: once per surface per page load. */
  const reportedTimeouts = new Set<string>();
  let watchingConsent = false;

  const untracked = <T extends SurfaceFields>(surfaceKey: string, fallback: T): T =>
    mergeFields(untrackedPayload(env.configSnapshot(), surfaceKey), fallback);

  function publish(entry: Entry, snapshot: SurfaceSnapshot<SurfaceFields>): void {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
  }

  function reportTimedOut(surfaceKey: string): void {
    // Only a visitor whose tracker is on can be counted; one who withdrew
    // consent meanwhile is not recorded.
    if (reportedTimeouts.has(surfaceKey) || !env.consentGranted()) return;
    reportedTimeouts.add(surfaceKey);
    try {
      env.reportTimeout(surfaceKey);
    } catch {
      // Measurement never decides what the page renders.
    }
  }

  /** Read the arm with the tracker on; `giveUp` is what the entry settles on without one. */
  function readTracked(entry: Entry, surfaceKey: string, cap: number, giveUp: () => SurfaceFields): void {
    entry.state = 'pending';
    let decided = false;
    const decide = (read: () => SurfaceFields): void => {
      if (decided) return;
      decided = true;
      let value: SurfaceFields;
      try {
        value = read();
      } catch {
        value = giveUp();
      }
      entry.state = 'latched';
      publish(entry, { value, settled: true });
    };

    env.setTimeout(() => {
      if (decided) return;
      decide(giveUp);
      reportTimedOut(surfaceKey);
    }, cap);
    env
      .loadSdk()
      .then(async (sdk) => {
        if (!sdk) return null;
        await sdk.ready();
        return sdk;
      })
      .then(
        // The thunk runs only if the cap has not fired: variation() is the exposure.
        (sdk) => decide(() => (sdk ? mergeFields(sdk.variation(surfaceKey, entry.fallback), entry.fallback) : giveUp())),
        () => decide(giveUp),
      );
  }

  /** A surface on screen keeps its painted copy while it is re-read with the tracker on. */
  function rereadPainted(entry: Entry, surfaceKey: string): void {
    const painted = entry.snapshot.value;
    readTracked(entry, surfaceKey, SURFACE_CONSENT_WAIT_MS, () => painted);
  }

  function onConsentChange(): void {
    if (!env.consentGranted()) return;
    for (const [surfaceKey, entry] of entries) {
      // Only what the visitor is looking at is read now. Reading IS the
      // exposure, so an off-screen surface waits for its next mount.
      if (entry.state === 'untracked' && entry.listeners.size > 0) rereadPainted(entry, surfaceKey);
    }
  }

  return {
    read<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceSnapshot<T> {
      const existing = entries.get(surfaceKey);
      if (existing && existing.state !== 'untracked') return existing.snapshot as SurfaceSnapshot<T>;
      const consented = env.consentGranted();

      if (existing) {
        // Still no consent: the same snapshot, so React sees a stable value.
        if (!consented) return existing.snapshot as SurfaceSnapshot<T>;
        // Consent arrived without the change signal reaching us (e.g. another tab)
        // while this surface is on screen: keep what is painted, re-read behind it.
        if (existing.listeners.size > 0) {
          rereadPainted(existing, surfaceKey);
          return existing.snapshot as SurfaceSnapshot<T>;
        }
        // Its next mount after consent: read like a first read with the tracker on.
        existing.snapshot = { value: fallback, settled: false };
        readTracked(existing, surfaceKey, SURFACE_WAIT_MS, () => untracked(surfaceKey, fallback));
        return existing.snapshot as SurfaceSnapshot<T>;
      }

      const entry: Entry = consented
        ? { state: 'pending', snapshot: { value: fallback, settled: false }, fallback, listeners: new Set() }
        : { state: 'untracked', snapshot: { value: untracked(surfaceKey, fallback), settled: true }, fallback, listeners: new Set() };
      entries.set(surfaceKey, entry);
      if (consented) readTracked(entry, surfaceKey, SURFACE_WAIT_MS, () => untracked(surfaceKey, fallback));
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
      };
    },
  };
}

/** The SDK, via the one shared script tag (widget.ts `loadWidgetScript`). */
function browserSdk(): Promise<EvolveSdk | null> {
  return new Promise((resolve) => {
    try {
      loadWidgetScript(() => {
        const sdk = window.RunHQWidget;
        const ready = sdk?.ready;
        const variation = sdk?.variation;
        if (sdk && typeof ready === 'function' && typeof variation === 'function') {
          resolve({
            ready: () => ready.call(sdk),
            variation: (surfaceKey, fallback) => variation.call(sdk, surfaceKey, fallback),
          });
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** Same signals RunHQWidget's useConsent reads: this tab's consent bar, and other tabs. */
function watchBrowserConsent(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === CONSENT_KEY) listener();
  };
  window.addEventListener(CONSENT_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CONSENT_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export const surfaceStore: SurfaceStore = createSurfaceStore({
  consentGranted: telemetryConsented,
  onConsentChange: watchBrowserConsent,
  configSnapshot: bootConfigSnapshot,
  loadSdk: browserSdk,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  // Consent-gated, guarded, and queued by the SDK until its tracker starts.
  reportTimeout: (surfaceKey) => trackEvent(SURFACE_TIMEOUT_EVENT, { surface: surfaceKey }),
});

/**
 * The copy for an Evolve surface. `fallback` must be a stable object (a module
 * constant): it is the shipped copy and the surface's declared default.
 */
export function useSurface<T extends SurfaceFields>(surfaceKey: string, fallback: T): SurfaceSnapshot<T> {
  const subscribe = useCallback((listener: () => void) => surfaceStore.subscribe(surfaceKey, listener), [surfaceKey]);
  return useSyncExternalStore(subscribe, () => surfaceStore.read(surfaceKey, fallback));
}
