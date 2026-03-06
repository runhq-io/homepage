/**
 * Machine Usage Billing Service
 *
 * Tracks machine uptime and deducts credits from server owner's balance.
 * Runs on a 5-minute tick to bill for elapsed machine time.
 */

import { db } from '../../db/index';
import { servers, subscriptions, type ServerTier } from '../../db/schema';
import { eq, and, isNotNull } from 'drizzle-orm';
import { getHourlyRate } from './providers/registry';
import type { ProviderId, TierId } from './providers/types';

// Legacy tier name → TierId mapping (for backward compat during transition)
const LEGACY_TIER_MAP: Record<string, TierId> = {
  'shared-cpu-1x': 'shared-4x-2gb',
  'shared-cpu-2x': 'shared-4x-4gb',
  'shared-cpu-4x': 'shared-4x-4gb',
  'performance-cpu-2x': 'perf-2x-4gb',
  'performance-cpu-4x': 'perf-4x-8gb',
  'micro': 'shared-4x-2gb',
  'small': 'shared-4x-4gb',
  'medium': 'shared-4x-4gb',
  'large': 'perf-4x-8gb',
  'xlarge': 'shared-8x-16gb',
  'xxlarge': 'perf-4x-32gb',
};

const NEW_TIER_IDS = new Set<string>([
  'shared-4x-2gb', 'shared-4x-4gb', 'shared-4x-8gb',
  'shared-8x-4gb', 'shared-8x-8gb', 'shared-8x-16gb',
  'perf-2x-4gb', 'perf-2x-8gb', 'perf-2x-16gb',
  'perf-4x-8gb', 'perf-4x-16gb', 'perf-4x-32gb',
]);

/**
 * Resolve a tier string (could be old Fly name or new TierId) to a TierId.
 */
function resolveTierId(tier: string | null): TierId {
  if (!tier) return 'shared-4x-2gb';
  if (NEW_TIER_IDS.has(tier)) return tier as TierId;
  if (tier in LEGACY_TIER_MAP) return LEGACY_TIER_MAP[tier];
  return 'shared-4x-2gb';
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
  'shared-cpu-1x': 1,       // $0.01/hr
  'shared-cpu-2x': 2,       // $0.02/hr
  'performance-cpu-2x': 14, // $0.14/hr
  'performance-cpu-4x': 27, // $0.27/hr
  'micro': 2,               // $0.02/hr
  'small': 3,               // $0.03/hr
  'medium': 4,              // $0.04/hr
  'large': 6,               // $0.06/hr
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
