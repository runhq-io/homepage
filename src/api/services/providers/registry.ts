/**
 * Provider Registry
 *
 * Manages available infrastructure providers.
 * Call initProviders() at startup, then use getProvider(id) everywhere.
 */

import type { IProvider } from './IProvider';
import type { ProviderId, TierId } from './types';
import { FlyProvider } from './FlyProvider';

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const providers = new Map<ProviderId, IProvider>();

// ---------------------------------------------------------------------------
// Per-provider hourly rates (cents)
// ---------------------------------------------------------------------------

const HOURLY_RATES: Record<ProviderId, Record<TierId, number>> = {
  fly: {
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
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initProviders(): void {
  const fly = new FlyProvider();
  providers.set('fly', fly);

  const configured = [...providers.values()].filter(p => p.isConfigured()).map(p => p.id);
  console.log(`[Providers] Initialized: ${configured.length ? configured.join(', ') : 'none configured'}`);
}

export function getProvider(id: ProviderId): IProvider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Provider '${id}' is not registered. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

export function hasProvider(id: ProviderId): boolean {
  return providers.has(id) && providers.get(id)!.isConfigured();
}

export function getAllProviders(): IProvider[] {
  return [...providers.values()];
}

/**
 * Get the default provider.
 */
export function getDefaultProviderId(): ProviderId {
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
  for (const p of providers.values()) {
    if (p.isConfigured()) return true;
  }
  return false;
}
