import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { evolveConfigPreloadTag, resolveApiBase, resolveTelemetryEnv } from './src/apiBase';

/**
 * Preload the Evolve serving config from index.html (R114, R115), so the copy
 * each visitor sees can be decided at first render instead of a round trip
 * later. The URL is resolved from the very env the app sees as
 * `import.meta.env` (Vite's resolved config), through the same rules the app
 * applies (src/apiBase.ts): API origin, project, and environment.
 *
 * The SDK (widget.js) is deliberately NOT preloaded: it would compete with the
 * app bundle for first paint. It loads after first paint (src/widget.ts).
 */
function preloadEvolveConfig(): Plugin {
  let tag = evolveConfigPreloadTag(resolveApiBase(undefined), 'production');
  return {
    name: 'runhq-preload-evolve-config',
    configResolved(config) {
      const apiBase = resolveApiBase(config.env.VITE_API_URL as string | undefined);
      const environment = resolveTelemetryEnv(config.env.VITE_RUNHQ_ENV as string | undefined, apiBase, config.isProduction);
      tag = evolveConfigPreloadTag(apiBase, environment);
    },
    transformIndexHtml: () => [tag],
  };
}

export default defineConfig({
  plugins: [react(), preloadEvolveConfig()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ['.tank.fish'],
  },
});
