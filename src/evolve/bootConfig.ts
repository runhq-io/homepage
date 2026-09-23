/**
 * The page's own Evolve config: fetched before React mounts, read synchronously
 * at first render (R114).
 *
 * What a visitor sees on an Evolve surface is decided from THIS answer and the
 * shared assignment block (evolveAssign.js), never by waiting for the SDK
 * (`widget.js`), which loads after first paint (R115). index.html preloads the
 * same URL (apiBase.ts `evolveConfigPreloadTag`), so on most loads the answer
 * has arrived before the bundle has even run.
 *
 * The request carries no identifier (credentials never reach the API origin),
 * so it is made for every marketing visitor regardless of consent: the answer
 * is public copy, the same for everyone.
 *
 * `window.__runhqEvolve` is the contract with widget.js (be/public/widget.js,
 * `evolveBootConfig` and `evolveAdoptPageRenders`):
 *   - `config`: the raw answer, which the SDK validates in its own spelling and
 *     adopts instead of fetching again;
 *   - `renders`: what the page painted before the SDK loaded. The SDK takes the
 *     queue (replacing the array with a sink) and records an exposure only when
 *     it would have picked the same arm for the same visitor. An SDK that
 *     predates the queue never takes it; `flushRendersToOlderSdk` then hands
 *     each render to its `variation()` instead (R118).
 * Change both sides or neither.
 */
import { API_BASE, RUNHQ_PROJECT, isBoardRoute } from '../widget';
import { TELEMETRY_ENV } from '../telemetry';
import { evolveConfigUrl } from '../apiBase';

/** One arm of a running run: what assignment needs, and what to paint. */
export interface ServedArm {
  variationId: string;
  /** The arm's name, when the answer carries it (viewer overrides name arms). */
  name?: string;
  weight: number;
  payload: unknown;
}

export interface ServedRun {
  experimentId: string;
  epoch: number;
  salt: string;
  arms: ServedArm[];
}

/** What the config says about one surface. */
export interface ServedSurface {
  surfaceKey: string;
  /** The copy a visitor who is not assigned sees; undefined = the shipped copy. */
  adopted: unknown;
  /** The run being tried, or null. */
  run: ServedRun | null;
}

export interface ServingConfig {
  environment: string;
  surfaces: Readonly<Record<string, ServedSurface>>;
}

/** A surface the page rendered before the SDK loaded; see widget.js `evolveAcceptPageRender`. */
export interface RenderEntry {
  surfaceKey: string;
  /** The shipped copy: the surface's declared default. */
  defaultPayload: unknown;
  /** The anon id the arm was assigned for (the SDK's `rw_anon_id`). */
  subjectKey: string;
  /** Present only when an arm was painted. */
  experimentId?: string;
  epoch?: number;
  variationId?: string;
}

/** `window.__runhqEvolve`, as widget.js reads it. */
export interface EvolveBoot {
  readonly v: 1;
  readonly project: string;
  readonly environment: string;
  /** Epoch ms when the request started; the SDK ignores a boot config older than 60 s. */
  readonly startedAt: number;
  readonly config: Promise<unknown>;
  /** The page's array until an SDK takes it; then the SDK's sink. */
  renders: RenderEntry[] | { push(entry: RenderEntry): unknown };
}

declare global {
  interface Window {
    __runhqEvolve?: EvolveBoot;
  }
}

/**
 * The fetch's request mode, matching index.html's `crossorigin="anonymous"`
 * preload. `same-origin` credentials send nothing to the API's origin.
 */
export const evolveConfigRequestInit = { mode: 'cors', credentials: 'same-origin' } as const;

type FetchLike = (
  url: string,
  init: typeof evolveConfigRequestInit,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Run-major spelling: every rule of widget.js `evolveValidConfig`. */
function validRunMajor(raw: Record<string, unknown>): boolean {
  if (!Array.isArray(raw.experiments)) return false;
  for (const e of raw.experiments) {
    if (!isRecord(e)) return false;
    if (typeof e.experimentId !== 'string' || typeof e.surfaceKey !== 'string' || typeof e.salt !== 'string') return false;
    if (!isFiniteNumber(e.epoch) || !Array.isArray(e.arms)) return false;
    for (const a of e.arms) {
      if (!isRecord(a) || typeof a.variationId !== 'string' || typeof a.name !== 'string') return false;
      if (!isFiniteNumber(a.weight)) return false;
      if (a.isControl !== undefined && typeof a.isControl !== 'boolean') return false;
    }
  }
  if (raw.defaults !== undefined) {
    if (!Array.isArray(raw.defaults)) return false;
    for (const d of raw.defaults) if (!isRecord(d) || typeof d.surfaceKey !== 'string') return false;
  }
  return true;
}

/** Per-surface spelling (R107, protocol `EvolveServingConfig`). */
function validSurfaces(surfaces: unknown): surfaces is Array<{ surfaceKey: string; adopted: unknown; run: ServedRun | null }> {
  if (!Array.isArray(surfaces)) return false;
  for (const s of surfaces) {
    if (!isRecord(s) || typeof s.surfaceKey !== 'string') return false;
    if (s.run === null || s.run === undefined) continue;
    const run = s.run;
    if (!isRecord(run) || typeof run.experimentId !== 'string' || typeof run.salt !== 'string') return false;
    if (!isFiniteNumber(run.epoch) || !Array.isArray(run.arms)) return false;
    for (const a of run.arms) {
      if (!isRecord(a) || typeof a.variationId !== 'string' || !isFiniteNumber(a.weight)) return false;
    }
  }
  return true;
}

interface RunMajorExperiment {
  experimentId: string;
  surfaceKey: string;
  epoch: number;
  salt: string;
  arms: Array<{ variationId: string; name: string; weight: number; payload: unknown; isControl?: boolean }>;
}

/**
 * The route's answer for THIS environment, in one shape, or null.
 *
 * The per-surface spelling is authoritative when present. The run-major one
 * (a BE without R107) says the same facts: a live run's control is what an
 * unassigned visitor sees (on a successor run, the adopted winner), and
 * `defaults` lists the adopted copy of surfaces with no run.
 */
export function parseServingConfig(raw: unknown, environment: string): ServingConfig | null {
  if (!isRecord(raw) || raw.environment !== environment) return null;
  const hasRunMajor = raw.experiments !== undefined;
  const hasSurfaces = raw.surfaces !== undefined;
  if (!hasRunMajor && !hasSurfaces) return null;
  if (hasRunMajor && !validRunMajor(raw)) return null;
  if (hasSurfaces && !validSurfaces(raw.surfaces)) return null;

  const experiments = (hasRunMajor ? raw.experiments : []) as RunMajorExperiment[];
  const surfaces: Record<string, ServedSurface> = {};

  if (hasSurfaces) {
    for (const s of raw.surfaces as Array<{ surfaceKey: string; adopted: unknown; run: ServedRun | null }>) {
      const named = s.run ? experiments.find((e) => e.experimentId === s.run!.experimentId) : undefined;
      surfaces[s.surfaceKey] = {
        surfaceKey: s.surfaceKey,
        adopted: s.adopted === null ? undefined : s.adopted,
        run: s.run
          ? {
              experimentId: s.run.experimentId,
              epoch: s.run.epoch,
              salt: s.run.salt,
              arms: s.run.arms.map((a) => {
                const name = named?.arms.find((n) => n.variationId === a.variationId)?.name;
                return { variationId: a.variationId, ...(name !== undefined ? { name } : {}), weight: a.weight, payload: a.payload };
              }),
            }
          : null,
      };
    }
    return { environment, surfaces };
  }

  for (const d of (raw.defaults ?? []) as Array<{ surfaceKey: string; payload: unknown }>) {
    surfaces[d.surfaceKey] = { surfaceKey: d.surfaceKey, adopted: d.payload, run: null };
  }
  for (const e of experiments) {
    const control = e.arms.find((a) => a.isControl === true);
    surfaces[e.surfaceKey] = {
      surfaceKey: e.surfaceKey,
      adopted: control ? control.payload : undefined,
      run: {
        experimentId: e.experimentId,
        epoch: e.epoch,
        salt: e.salt,
        arms: e.arms.map((a) => ({ variationId: a.variationId, name: a.name, weight: a.weight, payload: a.payload })),
      },
    };
  }
  return { environment, surfaces };
}

/** The page's boot config, as the surface store reads it. */
export interface EvolveBootHandle {
  /** Settles (never rejects) once the answer has been read, whatever it was. */
  readonly ready: Promise<void>;
  settled(): boolean;
  /** The parsed answer once settled; null while pending or when unusable. */
  config(): ServingConfig | null;
  /** ms since the page asked for the config (`performance.now()` based). */
  elapsed(): number;
  /**
   * ms from the page's request to the response's arrival: the browser's own
   * record of it (resource timing `responseEnd`) where it has one — which a
   * busy main thread cannot delay — else when its callback ran. Null while
   * nothing says it has arrived.
   */
  arrival(): number | null;
  /** Calls `listener` once the answer has settled (at once if it already has). */
  onSettle(listener: () => void): void;
  /** Queue a render for the SDK (window.__runhqEvolve.renders). */
  queueRender(entry: RenderEntry): void;
  /** True once an SDK has taken the render queue. */
  rendersTaken(): boolean;
  /** Empties and returns the queue while no SDK has taken it; [] once one has. */
  drainUntakenRenders(): RenderEntry[];
}

let current: EvolveBootHandle | null = null;

/** The boot started for this page load, or null (a board route, or none started). */
export function currentBoot(): EvolveBootHandle | null {
  return current;
}

/** The latest `responseEnd` the browser recorded for `url`, or null. */
function browserResponseEnd(url: string): number | null {
  try {
    const entries = performance.getEntriesByName(url) as PerformanceResourceTiming[];
    let end: number | null = null;
    for (const e of entries) if (e.responseEnd > 0 && (end === null || e.responseEnd > end)) end = e.responseEnd;
    return end;
  } catch {
    return null;
  }
}

export function startEvolveBoot(args: {
  apiBase: string;
  project: string;
  environment: string;
  fetchImpl?: FetchLike;
  /** Epoch ms, for the SDK's freshness check. */
  now?: () => number;
  /** Monotonic ms, for timing the answer (`performance.now`). */
  clock?: () => number;
  responseEnd?: (url: string) => number | null;
  target?: { __runhqEvolve?: EvolveBoot };
}): EvolveBootHandle {
  const fetchImpl: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const clock = args.clock ?? (() => performance.now());
  const responseEnd = args.responseEnd ?? browserResponseEnd;
  const url = evolveConfigUrl(args.apiBase, args.project, args.environment);
  const requestStart = clock();

  let settled = false;
  let parsed: ServingConfig | null = null;
  let settledArrival: number | null = null;
  const listeners: Array<() => void> = [];

  const recordedArrival = (): number | null => {
    const end = responseEnd(url);
    return end === null ? null : Math.max(0, end - requestStart);
  };

  let request: ReturnType<FetchLike>;
  try {
    request = fetchImpl(url, evolveConfigRequestInit);
  } catch (error) {
    request = Promise.reject(error);
  }

  const raw: Promise<unknown> = request
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (parseServingConfig(body, args.environment) ? body : null))
    .catch(() => null);

  const ready = raw.then((body) => {
    parsed = body === null ? null : parseServingConfig(body, args.environment);
    settledArrival = recordedArrival() ?? Math.max(0, clock() - requestStart);
    settled = true;
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch {
        // One surface's failure must not keep the others waiting.
      }
    }
  });

  const boot: EvolveBoot = {
    v: 1,
    project: args.project,
    environment: args.environment,
    startedAt: (args.now ?? Date.now)(),
    config: raw,
    renders: [],
  };
  const target = args.target ?? window;
  target.__runhqEvolve = boot;

  const handle: EvolveBootHandle = {
    ready,
    settled: () => settled,
    config: () => parsed,
    elapsed: () => clock() - requestStart,
    arrival: () => (settled ? settledArrival : recordedArrival()),
    onSettle(listener) {
      if (settled) listener();
      else listeners.push(listener);
    },
    queueRender(entry) {
      boot.renders.push(entry);
    },
    rendersTaken: () => !Array.isArray(boot.renders),
    drainUntakenRenders: () => (Array.isArray(boot.renders) ? boot.renders.splice(0) : []),
  };
  current = handle;
  return handle;
}

/**
 * An SDK older than the render queue (R118: the homepage must render right
 * whichever SDK the BE is serving) never takes it. Once that SDK is ready, each
 * queued render is handed to its `variation()`, which declares the surface and
 * records the exposure for the arm it derives — the same arm, because it is the
 * same assignment code over the same config (the page's boot config, which it
 * adopted) and the same id. A render made for an id the SDK does not hold is
 * dropped: its arm would be recorded against a different visitor.
 *
 * A render that painted NO arm is handed over only when the page's config shows
 * no run on that surface: that SDK's `variation()` assigns and records whenever
 * its config has a run, and this visitor saw no arm (their read missed the
 * config, or it had no run when it was read).
 */
export function flushRendersToOlderSdk(
  boot: EvolveBootHandle,
  sdk: { variation(surfaceKey: string, fallback: unknown): unknown },
  sdkVisitorId: string | null,
): void {
  const config = boot.config();
  for (const entry of boot.drainUntakenRenders()) {
    if (entry.subjectKey !== sdkVisitorId) continue;
    if (entry.variationId === undefined && (!config || config.surfaces[entry.surfaceKey]?.run)) continue;
    try {
      sdk.variation(entry.surfaceKey, entry.defaultPayload);
    } catch {
      // Measurement never decides what the page renders.
    }
  }
}

/**
 * How long the first render may wait to READ an answer that has already
 * arrived (its response is in; only its callbacks are pending).
 */
export const ARRIVED_READ_GRACE_MS = 100;

/**
 * Call `render` (React's first render) once the boot config can be read
 * synchronously — if it is already here.
 *
 * index.html preloads the config, so on most loads the whole answer has arrived
 * before the bundle has even run, yet reading it still takes a few tasks
 * (fetch → json). Rendering first would lay the surfaces out invisibly and
 * then have them wait on those tasks queued behind the app's own first render
 * and commit — hundreds of ms on a phone, measured. Reading first costs those
 * few tasks on an idle thread instead, so the copy is decided in the very
 * first render and paints with it.
 *
 * An answer that has NOT arrived is not waited for here: the page renders at
 * once and each surface waits for it, invisibly and up to its cap
 * (surface.ts). The grace bounds the hold whatever the promise does.
 */
export function renderWhenConfigRead(
  boot: Pick<EvolveBootHandle, 'settled' | 'arrival' | 'ready'> | null,
  render: () => void,
  setTimeoutFn: (fn: () => void, ms: number) => unknown = (fn, ms) => window.setTimeout(fn, ms),
): void {
  if (!boot || boot.settled() || boot.arrival() === null) {
    render();
    return;
  }
  let rendered = false;
  const once = () => {
    if (rendered) return;
    rendered = true;
    render();
  };
  boot.ready.then(once, once);
  setTimeoutFn(once, ARRIVED_READ_GRACE_MS);
}

/** Board routes belong to whichever project the visitor asked for — never RunHQ's config. */
export function shouldBootEvolve(pathname: string): boolean {
  return !isBoardRoute(pathname);
}

/** Called once from main.tsx, before React mounts. The boot, or null (a board, or a failure). */
export function bootEvolve(): EvolveBootHandle | null {
  try {
    if (!shouldBootEvolve(window.location.pathname)) {
      // index.html preloaded the config for every route. Read and drop it, so a
      // board page does not warn about an unused preload; nothing publishes it.
      fetch(evolveConfigUrl(API_BASE, RUNHQ_PROJECT, TELEMETRY_ENV), evolveConfigRequestInit).catch(() => {});
      return null;
    }
    return startEvolveBoot({ apiBase: API_BASE, project: RUNHQ_PROJECT, environment: TELEMETRY_ENV });
  } catch {
    // Evolve only ever changes copy; the page renders its shipped copy whatever happens here.
    return null;
  }
}
