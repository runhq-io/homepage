/**
 * Provider Registry
 *
 * Manages available infrastructure providers.
 * Call initProviders() at startup, then use getProvider(id) everywhere.
 */

import type { IProvider } from './IProvider';
import type { ProviderId, TierId } from './types';
import { FlyProvider } from './FlyProvider';
import { HetznerProvider } from './HetznerProvider';

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const providers = new Map<ProviderId, IProvider>();

// ---------------------------------------------------------------------------
// Per-provider hourly rates (cents)
// ---------------------------------------------------------------------------

const HOURLY_RATES: Record<ProviderId, Record<TierId, number>> = {
  fly: {
    micro: 2,   // $0.02/hr — shared-cpu-1x / 2GB
    small: 3,   // $0.03/hr — shared-cpu-2x / 4GB
    medium: 4,  // $0.04/hr — shared-cpu-4x / 4GB
    large: 6,   // $0.06/hr — shared-cpu-4x / 8GB
  },
  hetzner: {
    micro: 1,    // cx22: ~€0.0076/hr ≈ $0.008/hr
    small: 2,    // cx32: ~€0.0153/hr ≈ $0.017/hr
    medium: 5,   // cx42: ~€0.0306/hr ≈ $0.034/hr
    large: 10,   // cx52: ~€0.0611/hr ≈ $0.067/hr
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initProviders(): void {
  const fly = new FlyProvider();
  providers.set('fly', fly);

  if (process.env.HETZNER_API_TOKEN) {
    const hetzner = new HetznerProvider();
    providers.set('hetzner', hetzner);
  }

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
 * Get the default provider. Always prefer Fly.io — Hetzner is available but not default.
 */
export function getDefaultProviderId(): ProviderId {
  if (providers.has('fly') && providers.get('fly')!.isConfigured()) return 'fly';
  for (const p of providers.values()) {
    if (p.isConfigured()) return p.id;
  }
  return 'fly';
}

/**
 * Get hourly rate in cents for a provider+tier combination.
 * Falls back to Fly micro rate if lookup fails.
 */
export function getHourlyRate(providerId: ProviderId, tierId: TierId): number {
  return HOURLY_RATES[providerId]?.[tierId] ?? HOURLY_RATES.fly.micro;
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
