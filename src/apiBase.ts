/**
 * Build-time facts, as pure functions of the build's env.
 *
 * Kept free of `import.meta` so both sides of the build use the one rule: the
 * app (widget.ts `API_BASE`, telemetry.ts `TELEMETRY_ENV`, evolve/bootConfig)
 * and vite.config.ts, which writes the Evolve config preload into index.html.
 * A preload for a different URL (or request mode) than the one the app then
 * fetches is not reused: the browser fetches twice and warns.
 */

/** The fallback when a build declares no API origin: production. */
export const DEFAULT_API_BASE = 'https://console.runhq.io';

/**
 * The RunHQ-on-RunHQ project: the board where RunHQ's own users file RunHQ
 * bugs, and the project RunHQ's own telemetry and Evolve config belong to.
 */
export const RUNHQ_PROJECT = 'runhq';

export function resolveApiBase(declared: string | undefined): string {
  return declared?.replace(/\/+$/, '') || DEFAULT_API_BASE;
}

/** The canonical SDK script, served by the API. */
export function widgetScriptUrl(apiBase: string): string {
  return `${apiBase}/widget.js`;
}

/** The deployment an event belongs to, as RunHQ segments them. */
export type TelemetryEnv = 'production' | 'staging' | 'development';

const TELEMETRY_ENVS: readonly string[] = ['production', 'staging', 'development'];

/**
 * Which deployment this build reports as.
 *
 * `VITE_RUNHQ_ENV` is declared per environment in the deploy workflows, next to
 * `VITE_GA_ID`, and wins outright. It is plain config, not a secret.
 *
 * The fallback exists because a forgotten variable must fail towards *quiet*,
 * never towards polluting production:
 *   - a non-production build (local dev, tests) is always "development";
 *   - a production-mode build is read off the API host it was compiled against,
 *     which CI sets per environment (`console-staging.` ⇒ staging), so the
 *     staging site cannot report as production merely because someone forgot.
 */
export function resolveTelemetryEnv(
  declared: string | undefined,
  apiBase: string,
  isProd: boolean,
): TelemetryEnv {
  const explicit = typeof declared === 'string' ? declared.trim().toLowerCase() : '';
  if (TELEMETRY_ENVS.includes(explicit)) return explicit as TelemetryEnv;
  if (!isProd) return 'development';
  return /staging/i.test(apiBase) ? 'staging' : 'production';
}

/** The public Evolve serving config for one project + environment. */
export function evolveConfigUrl(apiBase: string, project: string, environment: string): string {
  return (
    `${apiBase}/api/widget/evolve/config?project=${encodeURIComponent(project)}` +
    `&environment=${encodeURIComponent(environment)}`
  );
}

/**
 * The `<link rel="preload">` for the Evolve config, as a Vite
 * `transformIndexHtml` tag (R114, R115).
 *
 * The copy a visitor sees is decided from this answer at first render, so it
 * is requested with the HTML — in parallel with the app bundle — rather than
 * once the bundle has run. It is tiny, public and carries no identifier.
 * `crossorigin="anonymous"` is request mode `cors` + credentials `same-origin`;
 * bootConfig's fetch uses exactly that (evolveConfigRequestInit), or the
 * browser would not reuse the preloaded response.
 *
 * There is deliberately NO preload of the SDK (widget.js): it competed with
 * the app bundle for the first paint of every visitor, most of whom never
 * need it before that paint. It loads after first paint (widget.ts).
 */
export function evolveConfigPreloadTag(
  apiBase: string,
  environment: string,
): {
  tag: 'link';
  attrs: { rel: 'preload'; as: 'fetch'; crossorigin: 'anonymous'; href: string };
  injectTo: 'head';
} {
  return {
    tag: 'link',
    attrs: { rel: 'preload', as: 'fetch', crossorigin: 'anonymous', href: evolveConfigUrl(apiBase, RUNHQ_PROJECT, environment) },
    injectTo: 'head',
  };
}
