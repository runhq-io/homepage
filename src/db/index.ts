/**
 * Unified database connection.
 *
 * Lazy-initializes the Drizzle client on first use (safe for Next.js builds
 * where DATABASE_URL may not be present) and auto-selects the driver:
 *   - @neondatabase/serverless for Neon URLs (production)
 *   - pg (node-postgres) for local/standard PostgreSQL
 *
 * Re-exports the canonical schema so consumers can do:
 *   import { db, users, agents, ... } from '@/db';
 */
import { createRequire } from 'node:module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const require = createRequire(import.meta.url);

let _db: NodePgDatabase<typeof schema> | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required to use the database.');
  }
  return url;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) {
    const url = requireDatabaseUrl();
    const isNeon = url.includes('neon.tech');

    if (isNeon) {
      // Use neon-serverless (WebSocket) rather than neon-http because the HTTP
      // driver does not support db.transaction() — which we need for MFA
      // enable/disable/regenerate-codes atomicity. Same package, different
      // driver; API-compatible with node-postgres.
      const { Pool, neonConfig } = require('@neondatabase/serverless');
      const { drizzle } = require('drizzle-orm/neon-serverless');
      const wsModule = require('ws');
      // Neon requires us to supply a WebSocket constructor in Node.
      neonConfig.webSocketConstructor = wsModule.WebSocket ?? wsModule;
      const pool = new Pool({ connectionString: url });
      _db = drizzle(pool, { schema }) as unknown as NodePgDatabase<typeof schema>;
    } else {
      const { Pool } = require('pg');
      const { drizzle } = require('drizzle-orm/node-postgres');
      const pool = new Pool({ connectionString: url });
      _db = drizzle(pool, { schema });
    }
  }
  return _db;
}

/**
 * Backwards-compatible `db` export.
 * Proxies to the lazily-initialized real connection, so imports that run at
 * module top-level during `next build` don't crash.
 */
export const db: NodePgDatabase<typeof schema> = new Proxy({} as any, {
  get(_target, prop) {
    const real = getDb() as any;
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

/** Performance helper */
export async function measureQuery<T>(name: string, queryFn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  console.log(`[DB] ${name}: starting...`);
  try {
    const result = await queryFn();
    const duration = performance.now() - start;
    console.log(`[DB] ${name}: completed in ${duration.toFixed(0)}ms`);
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    console.error(`[DB] ${name}: failed after ${duration.toFixed(0)}ms`, error);
    throw error;
  }
}

// Re-export schema for convenience
export * from './schema';
export { usageEvents, usageAdjustments, usageEventsRelations, usageAdjustmentsRelations } from './schema';
export type { UsageEvent, NewUsageEvent, UsageAdjustment, NewUsageAdjustment } from './schema';
