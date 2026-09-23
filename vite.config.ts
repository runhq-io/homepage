import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { resolveApiBase, widgetPreloadTag } from './src/apiBase';

/**
 * Preload the RunHQ SDK from index.html, so its download starts with the HTML
 * rather than after the app bundle has run (ruling R45). The URL is resolved
 * from the very env the app sees as `import.meta.env` (Vite's resolved config),
 * through the same rule the app applies (src/apiBase.ts).
 */
function preloadWidgetScript(): Plugin {
  let apiBase = resolveApiBase(undefined);
  return {
    name: 'runhq-preload-widget-script',
    configResolved(config) {
      apiBase = resolveApiBase(config.env.VITE_API_URL as string | undefined);
    },
    transformIndexHtml: () => [widgetPreloadTag(apiBase)],
  };
}

export default defineConfig({
  plugins: [react(), preloadWidgetScript()],
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
