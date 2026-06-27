/**
 * Provider Registry
 *
 * Manages available infrastructure providers.
 *
 * `initProviders()` is called explicitly from `src/server.ts` at startup
 * for the Hono side. The Next.js side runs in a separately bundled module
 * graph (Webpack vs the runtime tsx/tsc loader Hono uses), so its copy of
 * this module is a *different* instance with its own `providers` Map.
 * Without lazy fallback, `getProvider('fly')` on the Next.js side throws
 * "Provider 'fly' is not registered" — see /admin/migrations server action.
 *
 * Defense: every public lookup ensures the registry is initialized first.
 * Cheap, idempotent, and works regardless of which module graph this file
 * was loaded from.
 */

import type { IProvider } from './IProvider';
import type { ProviderId, TierId } from './types';
import { FlyProvider } from './FlyProvider';
import { DockerProvider } from './DockerProvider';

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const providers = new Map<ProviderId, IProvider>();
let initialized = false;

// ---------------------------------------------------------------------------
// Per-provider hourly rates (cents)
// ---------------------------------------------------------------------------

const HOURLY_RATES: Record<ProviderId, Record<TierId, number>> = {
  fly: {
    'shared-4x-1gb': 1,
    'shared-4x-2gb': 3,
    'shared-4x-4gb': 4,
    'shared-4x-8gb': 8,
    'shared-8x-4gb': 5,
    'shared-8x-8gb': 8,
    'shared-8x-16gb': 15,
    'perf-2x-4gb': 11,
    'perf-2x-8gb': 15,
    'perf-2x-16gb': 22,
    'perf-4x-8gb': 22,
    'perf-4x-16gb': 29,
    'perf-4x-32gb': 43,
  },
  docker: {
    'shared-4x-1gb': 0,
    'shared-4x-2gb': 0,
    'shared-4x-4gb': 0,
    'shared-4x-8gb': 0,
    'shared-8x-4gb': 0,
    'shared-8x-8gb': 0,
    'shared-8x-16gb': 0,
    'perf-2x-4gb': 0,
    'perf-2x-8gb': 0,
    'perf-2x-16gb': 0,
    'perf-4x-8gb': 0,
    'perf-4x-16gb': 0,
    'perf-4x-32gb': 0,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initProviders(): void {
  if (initialized) return;
  providers.set('fly', new FlyProvider());
  providers.set('docker', new DockerProvider());
  initialized = true;

  const configured = [...providers.values()].filter((p) => p.isConfigured()).map((p) => p.id);
  console.log(`[Providers] Initialized: ${configured.length ? configured.join(', ') : 'none configured'}`);
}

function ensureInitialized(): void {
  if (!initialized) initProviders();
}

export function getProvider(id: ProviderId): IProvider {
  ensureInitialized();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Provider '${id}' is not registered. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

export function hasProvider(id: ProviderId): boolean {
  ensureInitialized();
  return providers.has(id) && providers.get(id)!.isConfigured();
}

export function getAllProviders(): IProvider[] {
  ensureInitialized();
  return [...providers.values()];
}

/**
 * Get the default provider for the current process.
 *
 * Selection rules:
 *   1. LOCAL_PROVIDER=docker → 'docker' (explicit override; useful for local dev)
 *   2. LOCAL_PROVIDER=fly    → 'fly'    (explicit override; useful for debugging
 *      Fly-specific bugs from a local backend)
 *   3. NODE_ENV !== production → 'docker' (dev default — local containers, no
 *      production Fly machines)
 *   4. otherwise → 'fly' (production default)
 */
export function getDefaultProviderId(): ProviderId {
  const override = process.env.LOCAL_PROVIDER;
  if (override === 'docker' || override === 'fly') return override;
  if (process.env.NODE_ENV !== 'production') return 'docker';
  return 'fly';
}

/**
 * Get hourly rate in cents for a provider+tier combination.
 * Falls back to Fly micro rate if lookup fails.
 */
export function getHourlyRate(providerId: ProviderId, tierId: TierId): number {
  return HOURLY_RATES[providerId]?.[tierId] ?? HOURLY_RATES.fly['shared-4x-2gb'];
}

/**
 * Check if any remote provider is configured.
 * Replaces the old FlyService.isConfigured() checks.
 */
export function isAnyProviderConfigured(): boolean {
  ensureInitialized();
  for (const p of providers.values()) {
    if (p.isConfigured()) return true;
  }
  return false;
}
