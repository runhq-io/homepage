/**
 * Machine Usage Billing Service
 *
 * Tracks machine uptime and deducts credits from server owner's balance.
 * Runs on a 5-minute tick to bill for elapsed machine time.
 */

import { db } from '../../db/index';
import { servers, subscriptions, type ServerTier } from '../../db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { getHourlyRate, getProvider, hasProvider } from './providers/registry';
import type { ProviderId, TierId } from './providers/types';

// Legacy tier name → TierId mapping (for backward compat during transition)
const LEGACY_TIER_MAP: Record<string, TierId> = {
  'shared-cpu-1x': 'micro',
  'shared-cpu-2x': 'small',
  'performance-cpu-2x': 'medium',
  'performance-cpu-4x': 'large',
};

/**
 * Resolve a tier string (could be old Fly name or new TierId) to a TierId.
 */
function resolveTierId(tier: string | null): TierId {
  if (!tier) return 'micro';
  if (tier in LEGACY_TIER_MAP) return LEGACY_TIER_MAP[tier];
  // Already a new TierId
  if (['micro', 'small', 'medium', 'large'].includes(tier)) return tier as TierId;
  return 'micro';
}

/**
 * Get the hourly rate for a server's tier (supports both old and new tier names).
 */
function getServerHourlyRate(tier: string | null, providerId: ProviderId = 'fly'): number {
  const tierId = resolveTierId(tier);
  return getHourlyRate(providerId, tierId);
}

// Export legacy TIER_HOURLY_RATES for backward compat (tests, etc.)
export const TIER_HOURLY_RATES: Partial<Record<ServerTier, number>> = {
  'shared-cpu-1x': 1,       // $0.01/hr (Fly)
  'shared-cpu-2x': 2,       // $0.02/hr (Fly)
  'performance-cpu-2x': 14, // $0.14/hr (Fly)
  'performance-cpu-4x': 27, // $0.27/hr (Fly)
  'micro': 1,               // $0.01/hr (Hetzner cx22)
  'small': 2,               // $0.02/hr (Hetzner cx32)
  'medium': 5,              // $0.05/hr (Hetzner cx42)
  'large': 10,              // $0.10/hr (Hetzner cx52)
};

/**
 * Mark a machine as started (for billing purposes).
 * Sets machineStartedAt if not already set.
 */
export async function onMachineStarted(serverId: string): Promise<void> {
  const [server] = await db
    .select({ machineStartedAt: servers.machineStartedAt })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server || server.machineStartedAt) return;

  await db
    .update(servers)
    .set({ machineStartedAt: new Date() })
    .where(eq(servers.id, serverId));

  console.log(`[MachineUsage] Machine started for server ${serverId}`);
}

/**
 * Mark a machine as stopped. Bills any remaining time since machineStartedAt.
 */
export async function onMachineStopped(serverId: string): Promise<void> {
  const [server] = await db
    .select({
      machineStartedAt: servers.machineStartedAt,
      ownerId: servers.ownerId,
      tier: servers.tier,
      provider: servers.provider,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server || !server.machineStartedAt) return;

  // Bill remaining time
  const now = new Date();
  const minutes = (now.getTime() - server.machineStartedAt.getTime()) / 60000;
  const hourlyRate = getServerHourlyRate(server.tier, (server.provider || 'fly') as ProviderId);
  const costCents = Math.round((minutes / 60) * hourlyRate);

  if (costCents > 0 && server.ownerId) {
    await deductCredits(server.ownerId, costCents);
    console.log(`[MachineUsage] Final bill for ${serverId}: ${costCents}¢ (${Math.round(minutes)}min at ${hourlyRate}¢/hr)`);
  }

  // Clear machineStartedAt
  await db
    .update(servers)
    .set({ machineStartedAt: null })
    .where(eq(servers.id, serverId));
}

/**
 * Billing tick — runs every 5 minutes.
 * Finds all servers with machineStartedAt set, bills elapsed time,
 * and resets machineStartedAt to now (sliding billing window).
 */
export async function tickBilling(): Promise<void> {
  const now = new Date();

  // Find all servers with active machines (machineStartedAt is set, remote deployment)
  const activeServers = await db
    .select({
      id: servers.id,
      ownerId: servers.ownerId,
      tier: servers.tier,
      provider: servers.provider,
      machineStartedAt: servers.machineStartedAt,
      status: servers.status,
      lastSeen: servers.lastSeen,
    })
    .from(servers)
    .where(
      and(
        isNotNull(servers.machineStartedAt),
        eq(servers.deploymentType, 'remote'),
      )
    );

  if (activeServers.length === 0) return;

  let totalBilled = 0;

  for (const srv of activeServers) {
    if (!srv.machineStartedAt || !srv.ownerId) continue;

    // Safety: if server is actually offline (stale heartbeat > 5 min), stop billing
    if (srv.status === 'offline' || srv.status === 'error') {
      console.log(`[MachineUsage] Server ${srv.id} is ${srv.status}, stopping billing`);
      await onMachineStopped(srv.id);
      continue;
    }

    if (srv.lastSeen) {
      const staleMs = now.getTime() - srv.lastSeen.getTime();
      if (staleMs > 5 * 60 * 1000) {
        console.log(`[MachineUsage] Server ${srv.id} heartbeat stale (${Math.round(staleMs / 1000)}s), stopping billing`);
        await onMachineStopped(srv.id);
        continue;
      }
    }

    const minutes = (now.getTime() - srv.machineStartedAt.getTime()) / 60000;
    const hourlyRate = getServerHourlyRate(srv.tier, (srv.provider || 'fly') as ProviderId);
    const costCents = Math.round((minutes / 60) * hourlyRate);

    if (costCents > 0) {
      await deductCredits(srv.ownerId, costCents);
      totalBilled += costCents;
    }

    // Reset billing window
    await db
      .update(servers)
      .set({ machineStartedAt: now })
      .where(eq(servers.id, srv.id));
  }

  if (totalBilled > 0) {
    console.log(`[MachineUsage] Tick: billed ${totalBilled}¢ across ${activeServers.length} server(s)`);
  }
}

/**
 * Get machine usage info for a server.
 */
export async function getMachineUsage(serverId: string): Promise<{
  machineStartedAt: string | null;
  uptimeMinutes: number | null;
  hourlyRateCents: number;
  tier: ServerTier;
} | null> {
  const [server] = await db
    .select({
      machineStartedAt: servers.machineStartedAt,
      tier: servers.tier,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) return null;

  const tier = (server.tier || 'shared-cpu-1x') as ServerTier;
  const hourlyRateCents = getServerHourlyRate(tier);
  const uptimeMinutes = server.machineStartedAt
    ? (Date.now() - server.machineStartedAt.getTime()) / 60000
    : null;

  return {
    machineStartedAt: server.machineStartedAt?.toISOString() || null,
    uptimeMinutes: uptimeMinutes !== null ? Math.round(uptimeMinutes) : null,
    hourlyRateCents,
    tier,
  };
}

/**
 * Check for idle Hetzner machines and stop them.
 * Hetzner has no auto-suspend, so we stop machines with stale heartbeats.
 * Called alongside tickBilling on the same 5-minute interval.
 */
export async function checkIdleHetznerMachines(): Promise<void> {
  if (!hasProvider('hetzner')) return;

  const now = new Date();
  const idleThresholdMs = 15 * 60 * 1000; // 15 minutes default

  const hetznerServers = await db
    .select({
      id: servers.id,
      machineId: servers.machineId,
      status: servers.status,
      lastSeen: servers.lastSeen,
      autoSuspendEnabled: servers.autoSuspendEnabled,
      autoSuspendIdleMinutes: servers.autoSuspendIdleMinutes,
    })
    .from(servers)
    .where(
      and(
        eq(servers.provider, 'hetzner'),
        eq(servers.deploymentType, 'remote'),
        isNotNull(servers.machineId),
      )
    );

  for (const srv of hetznerServers) {
    if (!srv.machineId || !srv.autoSuspendEnabled) continue;
    if (srv.status !== 'online') continue;

    const idleMs = (srv.autoSuspendIdleMinutes ?? 15) * 60 * 1000;
    if (!srv.lastSeen) continue;

    const staleMs = now.getTime() - srv.lastSeen.getTime();
    if (staleMs < idleMs) continue;

    console.log(`[MachineUsage] Hetzner server ${srv.id} idle for ${Math.round(staleMs / 60000)}min, stopping`);
    try {
      const provider = getProvider('hetzner');
      await provider.stopMachine(srv.machineId);
      await onMachineStopped(srv.id);
      await db
        .update(servers)
        .set({ status: 'suspended', updatedAt: new Date() })
        .where(eq(servers.id, srv.id));
    } catch (error) {
      console.error(`[MachineUsage] Failed to stop idle Hetzner server ${srv.id}:`, error);
    }
  }
}

/**
 * Deduct credits from a user's subscription balance.
 */
async function deductCredits(userId: string, amountCents: number): Promise<void> {
  const [subscription] = await db
    .select({ id: subscriptions.id, creditBalanceCents: subscriptions.creditBalanceCents })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!subscription) return;

  const newBalance = Math.max(0, (subscription.creditBalanceCents || 0) - amountCents);

  await db
    .update(subscriptions)
    .set({ creditBalanceCents: newBalance, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscription.id));
}
