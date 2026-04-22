import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Load .env so integration tests can connect to the database without
    // requiring the caller to export DATABASE_URL manually.
    env: Object.fromEntries(
      (await import('node:fs').then(({ readFileSync }) => {
        try {
          return readFileSync(path.resolve(__dirname, '.env'), 'utf-8')
            .split('\n')
            .filter((line) => line && !line.startsWith('#') && line.includes('='));
        } catch {
          return [];
        }
      })).map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
    ),
  },
});
