/**
 * The page's own Evolve config fetch, started before React mounts.
 *
 * The hero is an Evolve surface, and the SDK (`widget.js`) only asks for the
 * variation config after its script has downloaded and `init()` has run, a full
 * round trip after first paint. Starting the same request here, at boot, means
 * the answer is already in flight; the SDK adopts it through
 * `window.__runhqEvolve` (be/public/widget.js `evolveBootConfig`) when it names
 * the same project and environment and is under a minute old.
 *
 * The request carries no identifier (`credentials: 'omit'`), so it is made for
 * every marketing visitor regardless of consent: it is the same class of
 * request as loading the script. Board routes are skipped — that traffic is
 * not RunHQ's (telemetry.ts `shouldTrack`).
 *
 * The contract with widget.js is shared and versioned. Change both or neither.
 */
import { API_BASE, RUNHQ_PROJECT, isBoardRoute } from '../widget';
import { TELEMETRY_ENV } from '../telemetry';

export interface ServingArm {
  variationId: string;
  name: string;
  weight: number;
  payload: unknown;
  isControl?: boolean;
}

export interface ServingExperiment {
  experimentId: string;
  surfaceKey: string;
  epoch: number;
  salt: string;
  arms: ServingArm[];
}

export interface ServingDefault {
  surfaceKey: string;
  payload: unknown;
}

export interface ServingConfig {
  environment: string;
  experiments: ServingExperiment[];
  defaults: ServingDefault[];
}

/** `window.__runhqEvolve`, as widget.js reads it. */
export interface EvolveBoot {
  readonly v: 1;
  readonly project: string;
  readonly environment: string;
  /** Epoch ms when the request started; the SDK ignores a boot older than 60 s. */
  readonly startedAt: number;
  readonly config: Promise<ServingConfig | null>;
}

declare global {
  interface Window {
    __runhqEvolve?: EvolveBoot;
  }
}

type FetchLike = (
  url: string,
  init: { credentials: 'omit' },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The route's response, for THIS environment, or null. Mirrors widget.js
 * `evolveValidConfig` rule for rule, so the two sides agree on what is usable.
 */
export function parseServingConfig(raw: unknown, environment: string): ServingConfig | null {
  if (!isRecord(raw) || raw.environment !== environment || !Array.isArray(raw.experiments)) return null;
  for (const e of raw.experiments) {
    if (!isRecord(e)) return null;
    if (typeof e.experimentId !== 'string' || typeof e.surfaceKey !== 'string' || typeof e.salt !== 'string') return null;
    if (!isFiniteNumber(e.epoch) || !Array.isArray(e.arms)) return null;
    for (const a of e.arms) {
      if (!isRecord(a) || typeof a.variationId !== 'string' || typeof a.name !== 'string') return null;
      if (!isFiniteNumber(a.weight)) return null;
      if (a.isControl !== undefined && typeof a.isControl !== 'boolean') return null;
    }
  }
  const defaults = raw.defaults === undefined ? [] : raw.defaults;
  if (!Array.isArray(defaults)) return null;
  for (const d of defaults) {
    if (!isRecord(d) || typeof d.surfaceKey !== 'string') return null;
  }
  return {
    environment,
    experiments: raw.experiments as ServingExperiment[],
    defaults: defaults as ServingDefault[],
  };
}

/**
 * What a visitor we cannot assign sees: the live run's control (what ships
 * today — on a successor run, the adopted winner), else the adopted default,
 * else nothing (the caller's shipped copy). Same rule as widget.js
 * `evolveUntrackedPayload`; never an arm.
 */
export function untrackedPayload(config: ServingConfig | null, surfaceKey: string): unknown {
  if (!config) return undefined;
  const running = config.experiments.find((e) => e.surfaceKey === surfaceKey);
  if (running) {
    const control = running.arms.find((a) => a.isControl === true);
    if (control) return control.payload;
  }
  return config.defaults.find((d) => d.surfaceKey === surfaceKey)?.payload;
}

let settledConfig: ServingConfig | null = null;

/** The boot config once it has settled, for synchronous reads; null until then. */
export function bootConfigSnapshot(): ServingConfig | null {
  return settledConfig;
}

export function startEvolveBoot(args: {
  apiBase: string;
  project: string;
  environment: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  target?: { __runhqEvolve?: EvolveBoot };
}): EvolveBoot {
  const fetchImpl: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  const url =
    `${args.apiBase}/api/widget/evolve/config?project=${encodeURIComponent(args.project)}` +
    `&environment=${encodeURIComponent(args.environment)}`;

  let request: ReturnType<FetchLike>;
  try {
    request = fetchImpl(url, { credentials: 'omit' });
  } catch (error) {
    request = Promise.reject(error);
  }

  const config = request
    .then((res) => (res.ok ? res.json() : null))
    .then((raw) => parseServingConfig(raw, args.environment))
    .catch(() => null)
    .then((parsed) => {
      settledConfig = parsed;
      return parsed;
    });

  const boot: EvolveBoot = {
    v: 1,
    project: args.project,
    environment: args.environment,
    startedAt: (args.now ?? Date.now)(),
    config,
  };
  (args.target ?? window).__runhqEvolve = boot;
  return boot;
}

/** Board routes belong to whichever project the visitor asked for — never RunHQ's config. */
export function shouldBootEvolve(pathname: string): boolean {
  return !isBoardRoute(pathname);
}

/** Called once from main.tsx, before React mounts. */
export function bootEvolve(): void {
  try {
    if (!shouldBootEvolve(window.location.pathname)) return;
    startEvolveBoot({ apiBase: API_BASE, project: RUNHQ_PROJECT, environment: TELEMETRY_ENV });
  } catch {
    // Evolve only ever changes copy; the page renders its shipped copy whatever happens here.
  }
}
