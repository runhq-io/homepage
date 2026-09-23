/**
 * The API/script origin, as a pure function of the build's `VITE_API_URL`.
 *
 * Kept free of `import.meta` so both sides of the build use the one rule: the
 * app (widget.ts `API_BASE`) and vite.config.ts, which writes the SDK preload
 * into index.html. A preload for a different URL than the one the loader
 * inserts would download the 850 KB script twice.
 */

/** The fallback when a build declares no API origin: production. */
export const DEFAULT_API_BASE = 'https://console.runhq.io';

export function resolveApiBase(declared: string | undefined): string {
  return declared?.replace(/\/+$/, '') || DEFAULT_API_BASE;
}

/** The canonical SDK script, served by the API. */
export function widgetScriptUrl(apiBase: string): string {
  return `${apiBase}/widget.js`;
}

/**
 * The `<link rel="preload">` for the SDK, as a Vite `transformIndexHtml` tag.
 *
 * No `crossorigin`: a preload is reused only by a request with the same
 * credentials mode, and the loader (widget.ts `loadWidgetScript`) inserts a
 * classic no-cors `<script>`. The two must change together.
 */
export function widgetPreloadTag(apiBase: string): {
  tag: 'link';
  attrs: { rel: 'preload'; as: 'script'; href: string };
  injectTo: 'head';
} {
  return { tag: 'link', attrs: { rel: 'preload', as: 'script', href: widgetScriptUrl(apiBase) }, injectTo: 'head' };
}
