/**
 * Server Service
 *
 * Handles server management with direct team membership.
 * - Create/update/delete servers
 * - Manage members and roles
 * - Handle invitations
 */

import { db } from '../../db/index';
import {
  servers,
  serverMembers,
  serverInvites,
  serverInviteLinks,
  serverBans,
  serverTemplates,
  publicPorts,
  workspaceTasks,
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  workspaceTaskVotes,
  users,
  type Server,
  type ServerRole,
  type DeploymentType,
  type ServerStatusType,
  type ServerTier,
} from '../../db/schema';
import { eq, and, gt, lte, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import * as CloudflareTunnelService from './CloudflareTunnelService';
import * as PublicPortService from './PublicPortService';
import { getOrCreateSubscription, PLAN_CONFIG, isAdmin } from './UsageService';
import * as MachineUsageService from './MachineUsageService';
import * as ServerSessionService from './ServerSessionService';
import { getUserByEmail } from '../../db/services';
import { getProvider, isAnyProviderConfigured, getDefaultProviderId } from './providers/registry';
import { flyTierToTierId, tierIdToFlyTier } from './providers/FlyProvider';
import { workspaceAppName, workspaceNetworkName } from './FlyService';
import type { ProviderId, VolumeInfo } from './providers/types';
import { computeMfaEnforcement } from '@/lib/workspaceMfaEnforcement';

// Server is considered offline after 60 seconds without heartbeat
const SERVER_HEARTBEAT_TIMEOUT_MS = 60_000;

// Fast-path threshold: skip wake/verify for machines with recent heartbeats (half of timeout)
const FAST_PATH_HEARTBEAT_THRESHOLD_MS = 30_000;

// ============================================================================
// Custom Errors
// ============================================================================

/**
 * Error thrown when remote server provisioning fails.
 * Contains the server that was created (in error state) so caller can handle cleanup.
 */
export class ProvisioningError extends Error {
  readonly server: Server;
  readonly serverToken: string;
  readonly cause: unknown;

  constructor(message: string, server: Server, serverToken: string, cause: unknown) {
    super(message);
    this.name = 'ProvisioningError';
    this.server = server;
    this.serverToken = serverToken;
    this.cause = cause;
  }
}

// ============================================================================
// Server Token Utilities
// ============================================================================

/**
 * Hash a server token using SHA-256
 */
function hashServerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ============================================================================
// Machine Provisioning
// ============================================================================

/**
 * Generate a secure server token
 */
function generateServerToken(): string {
  return `wst_${nanoid(32)}`;
}

async function getOrCreateTunnelCredentials(
  serverId: string,
  existingTunnelId?: string | null,
): Promise<{ tunnelId: string; tunnelToken: string; createdTunnelId: string | null }> {
  if (existingTunnelId) {
    const tunnelToken = await CloudflareTunnelService.getTunnelToken(existingTunnelId);
    return {
      tunnelId: existingTunnelId,
      tunnelToken,
      createdTunnelId: null,
    };
  }

  const tunnel = await CloudflareTunnelService.createTunnel(serverId);
  return {
    tunnelId: tunnel.tunnelId,
    tunnelToken: tunnel.tunnelToken,
    createdTunnelId: tunnel.tunnelId,
  };
}

/**
 * Provision a new machine for a server via the provider abstraction.
 * Handles: machine creation -> save IDs to DB -> wait for started -> wait for healthy -> set online.
 *
 * This is the shared core used by createServer, reprovisionRemoteServer, and changeRegion.
 * The caller is responsible for:
 * - Generating the server token and storing its hash
 * - Any pre-provisioning cleanup (deleting old machines, clearing old DB refs)
 * - Error handling (setting appropriate status on failure)
 */
async function provisionNewMachine(
  serverId: string,
  serverToken: string,
  region: string,
  tier?: ServerTier,
  autoSuspendEnabled: boolean = true,
  existingVolumeId?: string | null,
  existingTunnelId?: string | null,
  providerId?: ProviderId,
  tokenHash?: string,
  // Target Fly app for the new machine. Caller's responsibility to pick:
  //   • null  → use legacy shared app (env-default). For pre-migration
  //     workspaces undergoing changeRegion / changeTier / reprovision, this
  //     keeps the new machine in the same app as the existing volume so
  //     getOrCreateVolume can reuse it instead of creating an empty one
  //     (which would orphan real data — see docs/per-app-isolation-migration.md).
  //   • set  → use this per-tenant app. The app must already exist; the
  //     `createWorkspaceApp` helper used by createServer / migrate handles
  //     that. provisionNewMachine no longer auto-creates the app, so this
  //     argument is the only thing that determines target app.
  flyAppName?: string | null,
  flyNetworkName?: string | null,
): Promise<{ machineId: string; machineName: string; url: string; region: string; volumeId: string }> {
  const resolvedProviderId = providerId || getDefaultProviderId();
  const provider = getProvider(resolvedProviderId);

  // When a per-tenant target was supplied, ensure the Fly app exists. Idempotent —
  // createApp treats "already taken" as success — so this is safe whether the
  // app was already created (createServer pre-flight, prior retry, migration
  // step 3) or this is the first call. Keeping the call inside provisionNewMachine
  // means callers don't have to remember to create the app separately and
  // retries from any code path (reprovisionRemoteServer included) self-heal
  // the case where a prior createApp crashed mid-flight.
  if (flyAppName && flyNetworkName) {
    await provider.createApp(flyAppName, flyNetworkName);
    // Public-ingress prereq for per-tenant apps: allocate anycast IPs so the
    // app's own `.fly.dev` hostname resolves and Fly's edge can route TLS
    // traffic to it. POST /v1/apps doesn't auto-allocate; without this, the
    // CF DNS CNAME we install below would point at an unreachable hostname
    // and the workspace would 504 from outside (see
    // runhq/docs/per-app-isolation-migration.md, Path A).
    await provider.allocateIPs(flyAppName);
  }

  // Create Cloudflare tunnel for all providers (routes traffic through CF for TLS + IP hiding)
  let tunnelId: string | null = null;
  let tunnelToken: string | null = null;
  let createdTunnelId: string | null = null;
  if (CloudflareTunnelService.isConfigured()) {
    const tunnelResult = await getOrCreateTunnelCredentials(serverId, existingTunnelId);
    tunnelId = tunnelResult.tunnelId;
    tunnelToken = tunnelResult.tunnelToken;
    createdTunnelId = tunnelResult.createdTunnelId;
  }

  let provisionResult;

  try {
    const tierId = tier ? flyTierToTierId(tier) : ('shared-4x-2gb' as const);
    provisionResult = await provider.createMachine({
      serverId,
      serverToken,
      tunnelToken,
      region,
      tier: tierId,
      autoSuspendEnabled,
      existingVolumeId,
      appName: flyAppName ?? null,
      networkName: flyNetworkName ?? null,
    });
  } catch (error) {
    if (createdTunnelId) {
      try {
        await CloudflareTunnelService.deleteTunnel(createdTunnelId);
      } catch (cleanupError) {
        console.error(`[ServerService] Failed to cleanup tunnel ${createdTunnelId}:`, cleanupError);
      }
    }
    throw error;
  }

  // Save machine details immediately to prevent orphaned machines if wait times out.
  // Also atomically update tokenHash here (not before provisioning) so the old machine
  // can still register if provisioning fails — prevents orphaned-token mismatches.
  // Only write flyAppName / flyNetworkName when the caller explicitly targeted a
  // per-tenant app — for legacy callers (null) we must leave the existing columns
  // untouched so we don't accidentally flip a row to per-tenant or null out an
  // already-migrated row.
  //
  // CRITICAL ORDERING: this DB write MUST come before any further provisioning
  // step (DNS, cert, waits). Any step after this can fail and leave the
  // workspace in a partial-but-recoverable state — the row already references
  // the new machine, so reprovision/restart paths can re-run the missing
  // setup via ensureServerTunnelConnector. Phase 5's invariant.
  const machineUpdate: Record<string, unknown> = {
    serverUrl: provisionResult.serverUrl,
    machineId: provisionResult.machineId,
    machineName: provisionResult.machineName,
    region: provisionResult.region,
    volumeId: provisionResult.volumeId,
    tunnelId,
    tunnelToken: null,
    updatedAt: new Date(),
  };
  if (flyAppName) {
    machineUpdate.flyAppName = flyAppName;
    machineUpdate.flyNetworkName = flyNetworkName ?? null;
  }
  if (tokenHash) {
    machineUpdate.tokenHash = tokenHash;
  }
  await db
    .update(servers)
    .set(machineUpdate)
    .where(eq(servers.id, serverId));

  // Public ingress setup. Two paths depending on per-tenant vs legacy:
  //
  //   PER-TENANT (flyAppName set): install a CF DNS CNAME
  //   `srv-<machineId>.<domain>` → `<perTenantApp>.fly.dev` to override the
  //   wildcard `*.<domain>` (which points at the legacy shared app and
  //   would land traffic on the wrong Fly app — fly-replay can't cross
  //   apps). Also issue a Fly cert. The CF tunnel ingress rule is added
  //   either way because cloudflared inside the workspace also handles
  //   preview-port forwarding.
  //
  //   LEGACY (flyAppName null): rely on the wildcard CNAME → shared app +
  //   Fly's intra-app fly-replay; cfargotunnel CNAME for the ingress-rule
  //   path used by preview ports.
  //
  // BEST-EFFORT: this runs AFTER the DB cutover above. Any failure here
  // leaves the workspace with a real machine + DB row referencing it but
  // possibly broken public routing. Subsequent restart / wake / admin
  // backfill calls ensureServerTunnelConnector which re-runs the same
  // logic idempotently. Better than throwing and stranding a healthy
  // machine over a transient CF or Fly API blip.
  if (tunnelId && provisionResult.machineId) {
    const serverSubdomain = `srv-${provisionResult.machineId}`;
    try {
      await CloudflareTunnelService.addIngressRule(tunnelId, serverSubdomain, 61987);

      if (flyAppName) {
        const previewDomain = process.env.PREVIEW_DOMAIN ?? 'tank.fish';
        const fullHostname = `${serverSubdomain}.${previewDomain}`;
        // Write the override CNAME on the WORKSPACE zone (the same zone as
        // the wildcard *.<previewDomain> we need to override), NOT the
        // public-ports zone (runhq.io) which the legacy createDnsRecord
        // targets and which would put our record in the wrong place.
        await CloudflareTunnelService.createWorkspaceCnameRecord(fullHostname, `${flyAppName}.fly.dev`);
        // Issue Fly cert for the subdomain. Fly validates via ACME (HTTP-01
        // through CF proxy or Fly's own challenge), so this comes AFTER the
        // CNAME. addCertificate is best-effort internally — a pending/failed
        // validation doesn't block user traffic because CF's edge wildcard
        // cert handles user-facing TLS regardless.
        await provider.addCertificate(flyAppName, fullHostname);
      } else {
        await CloudflareTunnelService.createDnsRecord(serverSubdomain, tunnelId);
      }
    } catch (ingressErr) {
      console.error(
        `[ServerService] Public-ingress setup failed for server ${serverId} (machine ${provisionResult.machineId}). ` +
        `Workspace row references the new machine; subsequent restart/admin-backfill will retry via ensureServerTunnelConnector. ` +
        `Error:`, ingressErr
      );
    }
  }

  // Wait for machine to start. 10 min cap (was 3 min) — during the
  // per-app-isolation rollout, Fly's machine boot scheduling has been
  // observed taking many minutes during IAD congestion. The migration
  // runner needs the machine up before it can proceed with cutover, so
  // a longer cap is preferable to failing mid-flight on a transient
  // queue delay. The orphan resources and recovery path handle a
  // genuine boot failure cleanly.
  await provider.waitForState(provisionResult.machineId, ['running'], 600_000, flyAppName);

  // Wait for health checks. 5 min cap (was 1 min) — same reasoning as
  // the boot-state wait above. waitForHealthy returns silently on
  // timeout (without throwing), so the migration / provision can
  // complete even if the first health check is slow; this just gives
  // the machine more time to settle in for routing.
  await provider.waitForHealthy(provisionResult.machineId, 300_000, flyAppName);

  // Update status to online
  await db
    .update(servers)
    .set({ status: 'online', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  // Start machine billing
  await MachineUsageService.onMachineStarted(serverId);

  console.log(`[ServerService] Machine ${provisionResult.machineId} provisioned at ${provisionResult.serverUrl} (region: ${provisionResult.region}, provider: ${resolvedProviderId})`);
  return {
    machineId: provisionResult.machineId,
    machineName: provisionResult.machineName,
    url: provisionResult.serverUrl,
    region: provisionResult.region,
    volumeId: provisionResult.volumeId,
  };
}

// ============================================================================
// Server CRUD
// ============================================================================

/**
 * Create a new server (or ensure it exists)
 * Returns the server with plaintext serverToken (shown to user once, stored as hash)
 */
export async function createServer(
  ownerId: string,
  data: { id: string; name: string; deploymentType?: DeploymentType; region?: string; tier?: ServerTier; provider?: ProviderId }
): Promise<Server & { serverToken: string }> {
  // Check if server already exists
  const existing = await db.query.servers.findFirst({
    where: eq(servers.id, data.id),
  });

  if (existing) {
    // For existing servers, we can't return the plaintext token (it's hashed)
    // Return empty string - user would need to regenerate if they lost it
    return { ...existing, serverToken: '' };
  }

  // Generate a server token for remote server registration
  const serverToken = generateServerToken();
  const tokenHash = hashServerToken(serverToken);

  const deploymentType = data.deploymentType || 'local';

  const providerId = (data.provider || getDefaultProviderId()) as ProviderId;

  // Pre-compute the per-tenant Fly app + network names for remote workspaces
  // and persist them on the row at insert time. The names are deterministic
  // from data.id, so this is idempotent and durable across retries: if first
  // provisioning fails before the machine row write, the row still records
  // "this workspace is destined for ws-<id>" so reprovisionRemoteServer
  // (kicked off by the session endpoint when machineId is missing) targets
  // the correct app instead of falling back to the legacy shared one.
  const flyAppName = deploymentType === 'remote' ? workspaceAppName(data.id) : null;
  const flyNetworkName = deploymentType === 'remote' ? workspaceNetworkName(data.id) : null;

  const [server] = await db
    .insert(servers)
    .values({
      id: data.id,
      name: data.name,
      ownerId,
      tokenHash,
      deploymentType,
      provider: providerId,
      tier: data.tier || 'micro',
      region: data.region || 'ash',
      autoSuspendEnabled: true,
      status: deploymentType === 'remote' ? 'offline' : null,
      flyAppName,
      flyNetworkName,
    })
    .returning();

  // Add owner as a member with 'owner' role
  const [membership] = await db.insert(serverMembers).values({
    serverId: server.id,
    userId: ownerId,
    role: 'owner',
  }).returning();

  console.log(`[ServerService] Created server ${server.id} for user ${ownerId} (${deploymentType})`);
  console.log(`[ServerService] Added membership: ${membership?.id || 'FAILED'} (server=${server.id}, user=${ownerId})`);

  // If remote deployment, only provision machine if user has a payment method.
  // Without a card on file, server stays in 'pending' status (no machine).
  // The frontend will show a credit card gate; once the user adds a card and retries,
  // the session endpoint will trigger provisioning.
  if (deploymentType === 'remote' && isAnyProviderConfigured()) {
    const subscription = await getOrCreateSubscription(ownerId);
    if (subscription.stripeCustomerId) {
      console.log(`[ServerService] Kicking off background provisioning for server ${server.id}`);
      await db
        .update(servers)
        .set({ status: 'provisioning', updatedAt: new Date() })
        .where(eq(servers.id, server.id));
      // provisionNewMachine creates the per-tenant Fly app itself (idempotent)
      // when called with non-null flyAppName/flyNetworkName, so we just pass
      // the names persisted at row insert above. If this attempt fails, the
      // names remain on the row and the session-endpoint-driven retry path
      // (reprovisionRemoteServer) picks up the same app name — no shared-app
      // fallback.
      provisionNewMachine(
        server.id,
        serverToken,
        data.region || 'ash',
        data.tier,
        server.autoSuspendEnabled ?? true,
        undefined,
        undefined,
        providerId,
        undefined,
        flyAppName,
        flyNetworkName,
      ).catch(async (error) => {
        console.error(`[ServerService] Background provisioning failed for ${server.id}:`, error);
        await db
          .update(servers)
          .set({ status: 'error', updatedAt: new Date() })
          .where(eq(servers.id, server.id));
      });
    } else {
      console.log(`[ServerService] Skipping provisioning for ${server.id} — no payment method on file`);
    }
  }

  // Return server with plaintext token (user sees this once)
  return { ...server, serverToken };
}

/**
 * Ensure server exists in cloud (create if not)
 */
export async function ensureServer(
  serverId: string,
  ownerId: string,
  name: string = 'Untitled Server'
): Promise<Server> {
  const existing = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (existing) {
    return existing;
  }

  return createServer(ownerId, { id: serverId, name });
}

/**
 * Get server by ID
 */
export async function getServer(serverId: string): Promise<Server | null> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  return server || null;
}

/**
 * Get server by Fly machine ID
 */
export async function getServerByMachineId(machineId: string): Promise<Server | null> {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.machineId, machineId))
    .limit(1);

  return server ?? null;
}

/**
 * Ensure a remote server has a Cloudflare tunnel ID and connector token on its machine.
 * Tunnel token is fetched on-demand and never persisted in plaintext.
 */
export async function ensureServerTunnelConnector(
  serverId: string,
  options: { requireMachineUpdate?: boolean } = {},
): Promise<{ tunnelId: string; warnings: string[] } | null> {
  const server = await getServer(serverId);
  if (!server || server.deploymentType !== 'remote') {
    return null;
  }

  if (!CloudflareTunnelService.isConfigured()) {
    return null;
  }

  // Per-step warnings collected here are returned to the caller so admin
  // backfill / public-port-creation paths can surface partial-success
  // results instead of reporting a blanket "ok" when (e.g.) allocateIPs
  // failed silently.
  const warnings: string[] = [];

  const { tunnelId, tunnelToken } = await getOrCreateTunnelCredentials(serverId, server.tunnelId);

  if (server.tunnelId !== tunnelId || server.tunnelToken !== null) {
    await db
      .update(servers)
      .set({
        tunnelId,
        tunnelToken: null,
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));
  }

  if (server.machineId) {
    try {
      const provider = getProvider((server.provider || 'fly') as ProviderId);
      await provider.updateMachineEnv(server.machineId, { TUNNEL_TOKEN: tunnelToken }, server.flyAppName);
    } catch (error) {
      if (options.requireMachineUpdate) {
        throw error;
      }
      const msg = `Failed to ensure tunnel token on machine ${server.machineId}: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[ServerService] ${msg}`);
      warnings.push(msg);
    }

    // Add server routing ingress rule + DNS record (backfill for existing servers).
    //
    // The DNS record target depends on whether this is a per-tenant or legacy
    // workspace. Important: with per-tenant apps the wildcard CNAME
    // *.<domain> → legacy app would silently misroute traffic for this
    // machine; we install a SPECIFIC record overriding the wildcard.
    //
    // This branch is also the recovery path for pre-Phase-6 per-tenant
    // workspaces (those created in the Phase 2-only window before the
    // public-ingress code existed): admins can run the
    // /api/admin/backfill-tunnel-dns endpoint and it self-heals via the
    // calls below — allocateIPs (idempotent), CNAME (overrides wildcard),
    // certificate (idempotent).
    try {
      const serverSubdomain = `srv-${server.machineId}`;
      await CloudflareTunnelService.addIngressRule(tunnelId, serverSubdomain, 61987);

      if (server.flyAppName) {
        const provider = getProvider((server.provider || 'fly') as ProviderId);
        // Make sure the per-tenant app has public IPs. For workspaces created
        // pre-Phase-6 the app was created without IPs and `<app>.fly.dev`
        // doesn't resolve; without this, the CNAME below would point at an
        // unreachable hostname.
        try {
          await provider.allocateIPs(server.flyAppName);
        } catch (allocErr) {
          const msg = `allocateIPs failed for ${server.flyAppName}: ${allocErr instanceof Error ? allocErr.message : String(allocErr)}`;
          console.warn(`[ServerService] ${msg}`);
          warnings.push(msg);
        }

        const previewDomain = process.env.PREVIEW_DOMAIN ?? 'tank.fish';
        const fullHostname = `${serverSubdomain}.${previewDomain}`;
        // Same zone choice as provisionNewMachine — must be the workspace
        // zone (CLOUDFLARE_ZONE_ID) so the override actually shadows the
        // wildcard *.<previewDomain>.
        await CloudflareTunnelService.createWorkspaceCnameRecord(fullHostname, `${server.flyAppName}.fly.dev`);
        try {
          await provider.addCertificate(server.flyAppName, fullHostname);
        } catch (certErr) {
          const msg = `addCertificate failed for ${fullHostname}: ${certErr instanceof Error ? certErr.message : String(certErr)}`;
          console.warn(`[ServerService] ${msg}`);
          warnings.push(msg);
        }
      } else {
        await CloudflareTunnelService.createDnsRecord(serverSubdomain, tunnelId);
      }
    } catch (error) {
      const msg = `Failed to add server ingress rule for ${server.machineId}: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[ServerService] ${msg}`);
      warnings.push(msg);
    }
  }

  return { tunnelId, warnings };
}


/**
 * Get all servers a user is a member of
 */
export async function getUserServers(userId: string): Promise<Array<Server & { role: ServerRole; memberCount: number; sortOrder: number | null }>> {
  console.log(`[ServerService] getUserServers called for user: ${userId}`);

  const memberships = await db
    .select({
      server: servers,
      role: serverMembers.role,
      sortOrder: serverMembers.sortOrder,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, userId));

  // Also find servers where user is owner but has no member row (orphaned ownership)
  const memberServerIds = memberships.map(m => m.server.id);
  const ownedServers = await db
    .select()
    .from(servers)
    .where(eq(servers.ownerId, userId));

  for (const owned of ownedServers) {
    if (!memberServerIds.includes(owned.id)) {
      console.warn(`[ServerService] Found orphaned server ${owned.id} (${owned.name}) - owner has no member row, backfilling`);
      // Backfill the missing member row
      await db.insert(serverMembers).values({
        serverId: owned.id,
        userId,
        role: 'owner',
      });
      memberships.push({ server: owned, role: 'owner', sortOrder: null });
    }
  }

  // Get member counts for all servers in one query
  const serverIds = memberships.map(m => m.server.id);
  const memberCounts = serverIds.length > 0
    ? await db
        .select({
          serverId: serverMembers.serverId,
          count: sql<number>`count(*)::int`,
        })
        .from(serverMembers)
        .where(inArray(serverMembers.serverId, serverIds))
        .groupBy(serverMembers.serverId)
    : [];

  const memberCountMap = new Map(memberCounts.map(mc => [mc.serverId, mc.count]));

  console.log(`[ServerService] Found ${memberships.length} memberships for user ${userId}`);

  // Ensure all servers have token (backfill if missing)
  // Also check for stale heartbeats and mark servers as offline
  const results: Array<Server & { role: ServerRole; memberCount: number; sortOrder: number | null }> = [];
  const now = Date.now();

  for (const m of memberships) {
    let server = m.server;

    // Generate token if missing (for servers created before this feature)
    if (!server.tokenHash) {
      const newToken = generateServerToken();
      const [updated] = await db
        .update(servers)
        .set({ tokenHash: hashServerToken(newToken) })
        .where(eq(servers.id, server.id))
        .returning();
      if (updated) {
        server = updated;
      }
    }

    // Check if server heartbeat is stale - mark as offline if no heartbeat for > 60s
    if (server.status === 'online' && server.lastSeen) {
      const timeSinceHeartbeat = now - server.lastSeen.getTime();
      if (timeSinceHeartbeat > SERVER_HEARTBEAT_TIMEOUT_MS) {
        // Mark as offline in database
        const [updated] = await db
          .update(servers)
          .set({ status: 'offline' })
          .where(eq(servers.id, server.id))
          .returning();
        if (updated) {
          server = updated;
          console.log(`[ServerService] Marked stale server as offline for server ${server.id} (last seen ${Math.round(timeSinceHeartbeat / 1000)}s ago)`);
          // Stop machine billing
          await MachineUsageService.onMachineStopped(server.id);
        }
      }
    }

    const memberCount = memberCountMap.get(server.id) || 1;
    results.push({ ...server, role: m.role, memberCount, sortOrder: m.sortOrder });
  }

  return results;
}

/**
 * Update server
 */
export async function updateServer(
  serverId: string,
  userId: string,
  data: { name?: string; iconUrl?: string | null; autoSuspendEnabled?: boolean; autoSuspendIdleMinutes?: number }
): Promise<Server | null> {
  // Check if user has permission (owner only)
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return null;
  }

  const server = await getServer(serverId);
  if (!server) {
    return null;
  }

  const [updated] = await db
    .update(servers)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId))
    .returning();

  // If autoSuspendEnabled changed and server has a machine, update machine config
  if (
    typeof data.autoSuspendEnabled === 'boolean'
    && server.deploymentType === 'remote'
    && server.machineId
    && isAnyProviderConfigured()
  ) {
    try {
      const provider = getProvider((server.provider || 'fly') as ProviderId);
      await provider.updateAutoSuspendPolicy(server.machineId, data.autoSuspendEnabled, server.flyAppName);
    } catch (error) {
      console.error(`[ServerService] Failed to update machine autostop config:`, error);
      // Don't fail the update -- DB is already updated
    }
  }

  return updated || null;
}

/**
 * Every table that holds a foreign key to servers(id).
 *
 * Single source of truth for server-scoped DB cleanup: the
 * `deleteServersAndDependents` helper walks this list in order and deletes
 * dependent rows before removing the server row itself. A completeness test
 * (see ServerService.cascade.test.ts) asserts this list stays in sync with
 * the schema — if someone adds a new table with a FK to servers(id) without
 * registering it here, CI fails.
 *
 * Order is irrelevant for correctness (everything runs in one transaction
 * before the servers row is removed) but is kept stable for readability.
 */
export const SERVER_SCOPED_TABLES = [
  serverMembers,
  serverInvites,
  serverInviteLinks,
  serverBans,
  publicPorts,
  serverTemplates,
  // workspace_tasks children cascade on task_id, but their server_id FK still
  // blocks server deletion, so they must be cleared explicitly too.
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  workspaceTaskVotes,
  workspaceTasks,
] as const satisfies ReadonlyArray<PgTable & { serverId: unknown }>;

/**
 * Atomically delete the given server rows and every dependent row that
 * references them. All deletions run inside a single transaction: either
 * every row is removed, or none are — no possibility of leaving a server
 * with orphaned children (the bug this helper exists to prevent).
 *
 * This is *only* DB cleanup. Callers that also manage cloud infrastructure
 * (Fly machines/volumes, Cloudflare tunnels) are responsible for tearing
 * those down before calling this helper.
 */
export async function deleteServersAndDependents(serverIds: string[]): Promise<void> {
  if (serverIds.length === 0) return;

  await db.transaction(async (tx) => {
    for (const table of SERVER_SCOPED_TABLES) {
      await tx.delete(table).where(inArray((table as any).serverId, serverIds));
    }
    await tx.delete(servers).where(inArray(servers.id, serverIds));
  });
}

/**
 * Delete server (owner only)
 */
export async function deleteServer(serverId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only the owner can delete a server' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  // Delete cloud resources FIRST — abort if this fails to avoid orphaned machines.
  if (server.deploymentType === 'remote' && isAnyProviderConfigured()) {
    const remoteDeleted = await deleteRemoteServer(serverId);
    if (!remoteDeleted) {
      console.error(`[ServerService] Aborting delete of ${serverId}: cloud resources could not be fully removed`);
      return { success: false, error: 'Failed to delete cloud resources. Server not deleted to prevent orphaned machines.' };
    }
  }

  // External Cloudflare cleanup (DNS records, tunnel ingress, tunnel itself).
  // These live outside Postgres so they can't be handled by the DB helper.
  try {
    await PublicPortService.deleteAllPortMappings(serverId);
  } catch (error) {
    console.error(`[ServerService] Failed to delete port mappings (continuing):`, error);
  }

  if (server.tunnelId) {
    try {
      await CloudflareTunnelService.deleteTunnel(server.tunnelId);
    } catch (error) {
      console.error(`[ServerService] Failed to delete tunnel (continuing):`, error);
    }
  }

  // Atomic DB cleanup: servers row + every dependent row in one transaction.
  await deleteServersAndDependents([serverId]);

  console.log(`[ServerService] Deleted server ${serverId}`);
  return { success: true };
}

// ============================================================================
// Member Management
// ============================================================================

/**
 * Get all members of a server
 */
export async function getServerMembers(
  serverId: string
): Promise<Array<{ user: { id: string; email: string | null; username: string | null; name: string | null; avatarUrl: string | null }; role: ServerRole; joinedAt: Date }>> {
  const members = await db
    .select({
      userId: serverMembers.userId,
      role: serverMembers.role,
      joinedAt: serverMembers.joinedAt,
      userEmail: users.email,
      userUsername: users.username,
      userName: users.name,
      userAvatar: users.avatarUrl,
    })
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(eq(serverMembers.serverId, serverId));

  return members.map((m) => ({
    user: {
      id: m.userId,
      email: m.userEmail,
      username: m.userUsername,
      name: m.userName,
      avatarUrl: m.userAvatar,
    },
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

/**
 * Remove member from server
 */
export async function removeMember(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  // Only owner can remove members
  const hasPermission = await checkServerPermission(serverId, requesterId, ['owner']);
  if (!hasPermission) {
    return false;
  }

  // Can't remove owner
  const server = await getServer(serverId);
  if (server?.ownerId === targetUserId) {
    return false;
  }

  await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetUserId)));

  console.log(`[ServerService] Removed user ${targetUserId} from server ${serverId}`);
  return true;
}

/**
 * Leave server (self-removal)
 */
export async function leaveServer(serverId: string, userId: string): Promise<boolean> {
  // Owner can't leave (must transfer ownership first)
  const server = await getServer(serverId);
  if (server?.ownerId === userId) {
    return false;
  }

  await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

  console.log(`[ServerService] User ${userId} left server ${serverId}`);
  return true;
}

// ============================================================================
// Invitations
// ============================================================================

const INVITE_EXPIRY_DAYS = 7;

export type CreateInviteResult =
  | { success: true; token: string; expiresAt: Date }
  | { success: false; reason: 'no_permission' | 'already_member' };

/**
 * Whether userId can manage members/invites on this server.
 * Cloud-level owner OR per-server RBAC administrator/manage_roles.
 * Mirrors the runhq /invite-links gate in roles.ts.
 */
export async function canManageServerMembers(serverId: string, userId: string): Promise<boolean> {
  // Owner or is_admin mirror — local BE check; survives workspace outage.
  if (await checkCloudOpPermission(serverId, userId)) return true;
  // manage_roles is a workspace-specific permission without a BE mirror;
  // this leg still calls the workspace and degrades to false when it's down.
  if (await checkServerRBACPermission(serverId, userId, 'manage_roles')) return true;
  return false;
}

/**
 * Whether userId can change server-wide security policy (MFA enforcement,
 * future security toggles). Cloud-level owner OR per-server RBAC administrator.
 *
 * Separate from canManageServerMembers because security policy has a stricter
 * scope (no manage_roles fallback) — only full administrators should be able
 * to lock members out of the server.
 */
export async function canManageServerSecurity(serverId: string, userId: string): Promise<boolean> {
  // Owner or is_admin mirror — local BE check; survives workspace outage.
  return checkCloudOpPermission(serverId, userId);
}

/**
 * Create an invitation to join the server
 */
export async function createInvite(
  serverId: string,
  inviterId: string,
  email: string,
  role: ServerRole = 'member'
): Promise<CreateInviteResult> {
  if (!(await canManageServerMembers(serverId, inviterId))) {
    return { success: false, reason: 'no_permission' };
  }

  // Check if user is already a member
  const existingMember = await db
    .select()
    .from(serverMembers)
    .innerJoin(users, eq(serverMembers.userId, users.id))
    .where(and(eq(serverMembers.serverId, serverId), eq(users.email, email)))
    .limit(1);

  if (existingMember.length > 0) {
    console.log(`[ServerService] User ${email} is already a member of server ${serverId}`);
    return { success: false, reason: 'already_member' };
  }

  // Check for existing pending invite
  const existingInvite = await db
    .select()
    .from(serverInvites)
    .where(and(eq(serverInvites.serverId, serverId), eq(serverInvites.email, email), isNull(serverInvites.usedAt)))
    .limit(1);

  if (existingInvite.length > 0) {
    // Return existing invite token
    return {
      success: true,
      token: existingInvite[0].token,
      expiresAt: existingInvite[0].expiresAt,
    };
  }

  const token = nanoid(32);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(serverInvites).values({
    serverId,
    email,
    role,
    token,
    invitedById: inviterId,
    expiresAt,
  });

  console.log(`[ServerService] Created invite for ${email} to server ${serverId}`);
  return { success: true, token, expiresAt };
}

/**
 * Get pending invites for a server
 */
export async function getServerInvites(
  serverId: string
): Promise<Array<{ email: string; role: ServerRole; expiresAt: Date; createdAt: Date }>> {
  const invites = await db
    .select({
      email: serverInvites.email,
      role: serverInvites.role,
      expiresAt: serverInvites.expiresAt,
      createdAt: serverInvites.createdAt,
    })
    .from(serverInvites)
    .where(and(eq(serverInvites.serverId, serverId), isNull(serverInvites.usedAt)));

  return invites;
}

/**
 * Get invite info by token (public, no auth required)
 */
export async function getInviteInfo(token: string): Promise<{
  serverName: string;
  email: string;
  role: ServerRole;
  expiresAt: Date;
  valid: boolean;
} | null> {
  const [invite] = await db
    .select({
      email: serverInvites.email,
      role: serverInvites.role,
      expiresAt: serverInvites.expiresAt,
      usedAt: serverInvites.usedAt,
      serverId: serverInvites.serverId,
    })
    .from(serverInvites)
    .where(eq(serverInvites.token, token))
    .limit(1);

  if (!invite) return null;

  const [server] = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, invite.serverId))
    .limit(1);

  const valid = !invite.usedAt && invite.expiresAt > new Date();

  return {
    serverName: server?.name || 'Unknown Server',
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    valid,
  };
}

/**
 * Accept an invitation
 */
export async function acceptInvite(token: string, userId: string): Promise<{ success: boolean; serverId?: string; error?: string }> {
  const [invite] = await db
    .select()
    .from(serverInvites)
    .where(eq(serverInvites.token, token))
    .limit(1);

  if (!invite) {
    return { success: false, error: 'Invalid invite token' };
  }

  if (invite.usedAt) {
    return { success: false, error: 'Invite already used' };
  }

  if (invite.expiresAt < new Date()) {
    return { success: false, error: 'Invite expired' };
  }

  // Verify user email matches invite
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);

  if (!user || user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    return { success: false, error: 'Email does not match invite' };
  }

  // Check if banned
  if (await isUserBanned(invite.serverId, userId)) {
    return { success: false, error: 'You are banned from this server' };
  }

  // Check if already a member
  const existingMember = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, invite.serverId), eq(serverMembers.userId, userId)))
    .limit(1);

  if (existingMember.length > 0) {
    return { success: false, error: 'Already a member of this server' };
  }

  // Add as member
  await db.insert(serverMembers).values({
    serverId: invite.serverId,
    userId,
    role: invite.role,
    invitedById: invite.invitedById,
  });

  // Mark invite as used
  await db.update(serverInvites).set({ usedAt: new Date() }).where(eq(serverInvites.id, invite.id));

  console.log(`[ServerService] User ${userId} accepted invite to server ${invite.serverId}`);
  return { success: true, serverId: invite.serverId };
}

/**
 * Cancel/revoke an invitation
 */
export async function cancelInvite(serverId: string, requesterId: string, email: string): Promise<boolean> {
  if (!(await canManageServerMembers(serverId, requesterId))) {
    return false;
  }

  await db
    .delete(serverInvites)
    .where(and(eq(serverInvites.serverId, serverId), eq(serverInvites.email, email), isNull(serverInvites.usedAt)));

  return true;
}

/**
 * Get pending server invites for a user (by email)
 */
export async function getUserPendingInvites(
  email: string
): Promise<Array<{ token: string; serverId: string; serverName: string; inviterEmail: string; role: ServerRole; expiresAt: Date }>> {
  const invites = await db
    .select({
      token: serverInvites.token,
      serverId: serverInvites.serverId,
      role: serverInvites.role,
      expiresAt: serverInvites.expiresAt,
      serverName: servers.name,
      invitedById: serverInvites.invitedById,
    })
    .from(serverInvites)
    .innerJoin(servers, eq(serverInvites.serverId, servers.id))
    .where(and(eq(serverInvites.email, email.toLowerCase()), isNull(serverInvites.usedAt)));

  // Get inviter emails
  const validInvites = invites.filter((i) => i.expiresAt > new Date());
  const inviterIds = [...new Set(validInvites.map(i => i.invitedById))];

  const inviters = inviterIds.length > 0
    ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, inviterIds))
    : [];
  const inviterMap = new Map(inviters.map(u => [u.id, u.email]));

  return validInvites.map(inv => ({
    token: inv.token,
    serverId: inv.serverId,
    serverName: inv.serverName,
    inviterEmail: inviterMap.get(inv.invitedById) || 'unknown',
    role: inv.role,
    expiresAt: inv.expiresAt,
  }));
}

/**
 * Accept an invitation by server ID (for the current user)
 */
export async function acceptInviteByServer(serverId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  // Get user's email
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.email) {
    return { success: false, error: 'User not found' };
  }

  // Find the pending invite for this user + server
  const [invite] = await db
    .select()
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.email, user.email.toLowerCase()),
      isNull(serverInvites.usedAt)
    ))
    .limit(1);

  if (!invite) {
    return { success: false, error: 'No pending invite found' };
  }

  if (invite.expiresAt < new Date()) {
    return { success: false, error: 'Invite expired' };
  }

  // Check if banned
  if (await isUserBanned(serverId, userId)) {
    return { success: false, error: 'You are banned from this server' };
  }

  // Check if already a member
  const existingMember = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);

  if (existingMember.length > 0) {
    return { success: false, error: 'Already a member of this server' };
  }

  // Add as member
  await db.insert(serverMembers).values({
    serverId,
    userId,
    role: invite.role,
    invitedById: invite.invitedById,
  });

  // Mark invite as used
  await db.update(serverInvites).set({ usedAt: new Date() }).where(eq(serverInvites.id, invite.id));

  console.log(`[ServerService] User ${userId} accepted invite to server ${serverId}`);
  return { success: true };
}

/**
 * Decline an invitation by server ID (for the current user)
 */
export async function declineInviteByServer(serverId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  // Get user's email
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.email) {
    return { success: false, error: 'User not found' };
  }

  // Delete the pending invite for this user + server
  const result = await db
    .delete(serverInvites)
    .where(and(
      eq(serverInvites.serverId, serverId),
      eq(serverInvites.email, user.email.toLowerCase()),
      isNull(serverInvites.usedAt)
    ));

  console.log(`[ServerService] User ${userId} declined invite to server ${serverId}`);
  return { success: true };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Set server status (used to prevent race conditions in background operations)
 */
export async function setServerStatus(serverId: string, status: ServerStatusType): Promise<void> {
  await db
    .update(servers)
    .set({ status, updatedAt: new Date() })
    .where(eq(servers.id, serverId));
}

/**
 * Cloud-op permission check: is this user allowed to perform machine-lifecycle
 * and other cloud-level operations on this server?
 *
 * Returns true when the user is either:
 *   - a cloud 'owner' in server_members (BE-authoritative), or
 *   - marked is_admin=true in server_members (workspace-derived mirror —
 *     synced from the workspace on every role change + on boot)
 *
 * Reads only local BE state. Unlike checkServerRBACPermission, does NOT call
 * the workspace — so this check succeeds even when the workspace is crashed,
 * which is exactly when admins need to restart it.
 */
export async function checkCloudOpPermission(serverId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: serverMembers.role, isAdmin: serverMembers.isAdmin })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (row) {
    return row.role === 'owner' || row.isAdmin === true;
  }
  // Fallback: servers.ownerId is the source of truth if server_members is missing.
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return server?.ownerId === userId;
}

/**
 * Check if user has required permission in server
 */
export async function checkServerPermission(serverId: string, userId: string, allowedRoles: ServerRole[]): Promise<boolean> {
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);

  console.log(`[checkServerPermission] serverId=${serverId} userId=${userId} allowedRoles=${allowedRoles} membership=${JSON.stringify(membership)}`);

  if (membership) {
    return allowedRoles.includes(membership.role);
  }

  // Fallback: check if user is the server owner (servers.ownerId is the source of truth)
  // This handles cases where the server_members record is missing
  if (allowedRoles.includes('owner')) {
    const [server] = await db
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return server?.ownerId === userId;
  }

  return false;
}

/**
 * Get member's role in server
 */
export async function getMemberRole(serverId: string, userId: string): Promise<ServerRole | null> {
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);

  if (membership?.role) {
    return membership.role;
  }

  // Fallback: check if user is the server owner (servers.ownerId is the source of truth)
  // This handles cases where the server_members record is missing or has stale data
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (server?.ownerId === userId) {
    console.warn(`[ServerService] getMemberRole: user ${userId} is server owner but missing server_members record for server ${serverId}, returning 'owner'`);
    return 'owner';
  }

  return null;
}

/**
 * Check if user can access a server
 */
export async function canAccessServer(serverId: string, userId: string): Promise<boolean> {
  return checkServerPermission(serverId, userId, ['owner', 'member']);
}

/**
 * Check if user can edit a server
 */
export async function canEditServer(serverId: string, userId: string): Promise<boolean> {
  return checkServerPermission(serverId, userId, ['owner', 'member']);
}

export type ServerAccessGate =
  | { ok: true }
  | { ok: false; status: 403; body: { error: 'Forbidden' } }
  | { ok: false; status: 403; body: {
      error: 'MFA_REQUIRED';
      serverId?: string;
      serverName?: string;
      deadline?: string;
    } };

/**
 * Workspace authorization gate for read access. Combines MFA-enforcement
 * check (returns MFA_REQUIRED if the user is past grace on any required
 * workspace) with the existing canAccessServer check.
 *
 * Invariants:
 *   - MFA enforcement is checked FIRST; a user past grace cannot touch any
 *     server regardless of membership.
 *   - Delegates to canAccessServer for the membership decision; that helper
 *     remains a pure boolean so non-HTTP callers (e.g. wsHandlers) can
 *     continue to use it.
 */
export async function gateServerAccess(serverId: string, userId: string): Promise<ServerAccessGate> {
  const mfa = await computeMfaEnforcement(userId);
  if (mfa.status === 'required') {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'MFA_REQUIRED',
        serverId: mfa.serverId,
        serverName: mfa.serverName,
        deadline: mfa.deadline?.toISOString(),
      },
    };
  }
  const allowed = await canAccessServer(serverId, userId);
  return allowed ? { ok: true } : { ok: false, status: 403, body: { error: 'Forbidden' } };
}

/**
 * Same as gateServerAccess but for edit operations. See gateServerAccess
 * for invariants.
 */
export async function gateServerEdit(serverId: string, userId: string): Promise<ServerAccessGate> {
  const mfa = await computeMfaEnforcement(userId);
  if (mfa.status === 'required') {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'MFA_REQUIRED',
        serverId: mfa.serverId,
        serverName: mfa.serverName,
        deadline: mfa.deadline?.toISOString(),
      },
    };
  }
  const allowed = await canEditServer(serverId, userId);
  return allowed ? { ok: true } : { ok: false, status: 403, body: { error: 'Forbidden' } };
}

/**
 * Check if user has a specific permission in the server's RBAC system.
 * Calls the running server's /permissions/check endpoint with a signed JWT.
 * Falls back to cloud-level role check if the server is unreachable.
 */
export async function checkServerRBACPermission(
  serverId: string,
  userId: string,
  permission: string = 'administrator',
): Promise<boolean> {
  const server = await getServer(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  if (!server.serverUrl) return false;

  try {
    const data = await fetchFromServer<{ success: boolean; hasPermission?: boolean }>(
      server, userId, `/permissions/check?userId=${encodeURIComponent(userId)}&permission=${encodeURIComponent(permission)}`,
    );
    return data.success && data.hasPermission === true;
  } catch (error) {
    console.warn(`[ServerService] RBAC check unreachable for ${serverId}:`, error);
    return false;
  }
}

/**
 * Fetch from a running server machine with proper authentication and routing.
 * Generates a short-lived JWT and adds Fly machine routing headers automatically.
 * Use this for all BE→server API calls to avoid routing issues.
 */
export async function fetchFromServer<T = unknown>(
  server: Server,
  userId: string,
  path: string,
  options?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const { url: baseUrl, headers } = await buildServerFetchHeaders(server, userId);
  const url = new URL(path, baseUrl);

  const res = await fetch(url.toString(), {
    method: options?.method || 'GET',
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 5000),
  });

  if (!res.ok) {
    throw new Error(`Server responded with HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ============================================================================
// Server Registration
// ============================================================================

/**
 * Get server by token (for server registration)
 * Hashes the incoming token and looks up by hash
 */
export async function getServerByToken(serverToken: string): Promise<Server | null> {
  const tokenHash = hashServerToken(serverToken);

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.tokenHash, tokenHash))
    .limit(1);

  return server || null;
}

/**
 * Register a server
 */
export async function registerServer(
  serverToken: string,
  serverUrl: string,
  machineId?: string
): Promise<{ success: boolean; server?: Server; error?: string }> {
  // When machineId is provided, try to match by both token AND machineId first.
  // This prevents the wrong server from being updated when multiple servers
  // share the same token (e.g. after a machine clone operation).
  const tokenHash = hashServerToken(serverToken);
  let server: Server | null = null;

  if (machineId) {
    const [byMachine] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.tokenHash, tokenHash), eq(servers.machineId, machineId)))
      .limit(1);
    server = byMachine || null;
  }

  // Fall back to token-only lookup (original behavior for local/self-hosted servers)
  if (!server) {
    server = await getServerByToken(serverToken);
  }

  if (!server) {
    return { success: false, error: 'Invalid server token' };
  }

  const updates: Record<string, unknown> = {
    serverUrl,
    status: 'online',
    lastSeen: new Date(),
    updatedAt: new Date(),
  };

  // Only update machineId if:
  // 1. The server doesn't have a machineId yet (fresh provision), OR
  // 2. The registering machine matches the one already on record.
  // This prevents a rogue/temp machine with the same token from hijacking the record.
  if (machineId && typeof machineId === 'string') {
    if (!server.machineId || server.machineId === machineId) {
      updates.machineId = machineId;
    } else {
      console.warn(`[ServerService] Rejecting machineId update for server ${server.id}: incoming=${machineId}, existing=${server.machineId}`);
      return { success: false, error: 'Machine ID mismatch — server already has a different machine assigned' };
    }
  }

  const [updated] = await db
    .update(servers)
    .set(updates)
    .where(eq(servers.id, server.id))
    .returning();

  console.log(`[ServerService] Server registered for server ${server.id} at ${serverUrl}${machineId ? ` (machineId: ${machineId})` : ''}`);
  return { success: true, server: updated };
}

/**
 * Update server heartbeat (keep-alive)
 */
export async function updateServerHeartbeat(serverToken: string, machineId?: string, isIdle?: boolean): Promise<boolean> {
  // When machineId is provided, match by both token AND machineId to avoid
  // updating the wrong server when multiple servers share the same token.
  const tokenHash = hashServerToken(serverToken);
  let server: Server | null = null;

  if (machineId) {
    const [byMachine] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.tokenHash, tokenHash), eq(servers.machineId, machineId)))
      .limit(1);
    server = byMachine || null;
  }

  if (!server) {
    server = await getServerByToken(serverToken);
  }

  if (!server) {
    return false;
  }

  // Reject heartbeat from a machine that doesn't match the server's assigned machine.
  // This prevents rogue/temp machines from affecting the real server's status.
  if (machineId && server.machineId && server.machineId !== machineId) {
    console.warn(`[ServerService] Rejecting heartbeat for server ${server.id}: incoming machineId=${machineId}, assigned=${server.machineId}`);
    return false;
  }

  // Track idle state for app-managed auto-suspend.
  // idleSince = when the server first started reporting idle continuously.
  // - If isIdle transitions to true → set idleSince to now (if not already set)
  // - If isIdle transitions to false → clear idleSince
  const updateData: Record<string, unknown> = {
    status: 'online',
    lastSeen: new Date(),
  };

  if (isIdle === true && !server.idleSince) {
    updateData.idleSince = new Date();
  } else if (isIdle === false && server.idleSince) {
    updateData.idleSince = null;
  }

  await db
    .update(servers)
    .set(updateData)
    .where(eq(servers.id, server.id));

  // Ensure billing is tracking this machine
  if (!server.machineStartedAt && server.deploymentType === 'remote') {
    await MachineUsageService.onMachineStarted(server.id);
  }

  return true;
}

/**
 * Mark server as offline
 */
export async function markServerOffline(serverId: string): Promise<void> {
  // Stop machine billing before marking offline
  await MachineUsageService.onMachineStopped(serverId);

  await db
    .update(servers)
    .set({
      status: 'offline',
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId));

  console.log(`[ServerService] Server marked offline for server ${serverId}`);
}

/**
 * Update session token expiry for a server.
 * Validates range [900, 259200].
 */
export async function updateSessionTokenExpiry(
  serverId: string,
  expirySeconds: number,
): Promise<number> {
  const MIN_EXPIRY = 900;    // 15 minutes
  const MAX_EXPIRY = 259200; // 3 days

  if (!Number.isInteger(expirySeconds) || expirySeconds < MIN_EXPIRY || expirySeconds > MAX_EXPIRY) {
    throw new Error(`sessionTokenExpirySeconds must be an integer between ${MIN_EXPIRY} and ${MAX_EXPIRY}`);
  }

  await db
    .update(servers)
    .set({ sessionTokenExpirySeconds: expirySeconds, updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  return expirySeconds;
}

// ============================================================================
// MFA enforcement policy (per-server)
// ============================================================================

export interface ServerMfaStatus {
  requireMfa: boolean;
  requireMfaEnforcedAt: string | null;
  totalMembers: number;
  membersWithMfa: number;
  /** Only populated for the server owner (privacy + scope of action). */
  membersWithout?: Array<{ userId: string; email: string | null; name: string | null }>;
}

/**
 * Return MFA-enforcement status for a server. Any member may read counts;
 * only users who can manage security (owner/administrator) see the list of
 * members without MFA — they're the ones who can act on it.
 *
 * Caller is responsible for access control (use gateServerAccess).
 * Returns null when the server doesn't exist.
 */
export async function getServerMfaStatus(
  serverId: string,
  viewerId: string,
): Promise<ServerMfaStatus | null> {
  const [server] = await db.select({
    requireMfa: servers.requireMfa,
    enforcedAt: servers.requireMfaEnforcedAt,
  }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) return null;

  const members = await db.select({
    userId: users.id,
    email: users.email,
    name: users.name,
    mfaEnabled: users.mfaEnabled,
  })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(eq(serverMembers.serverId, serverId));

  const total = members.length;
  const withMfa = members.filter((m) => m.mfaEnabled).length;
  const canManage = await canManageServerSecurity(serverId, viewerId);
  const membersWithout = canManage
    ? members.filter((m) => !m.mfaEnabled).map(({ userId, email, name }) => ({ userId, email, name }))
    : undefined;

  return {
    requireMfa: server.requireMfa,
    requireMfaEnforcedAt: server.enforcedAt ? server.enforcedAt.toISOString() : null,
    totalMembers: total,
    membersWithMfa: withMfa,
    membersWithout,
  };
}

/**
 * Set a server's MFA-enforcement policy. Toggling on records the enforcement
 * timestamp (used for the grace-period deadline); toggling off clears it.
 *
 * Caller is responsible for owner-only access control — this function trusts
 * its inputs and only touches the DB.
 *
 * Returns the applied state, or null if the server doesn't exist.
 */
export async function setServerRequireMfa(
  serverId: string,
  requireMfa: boolean,
): Promise<{ requireMfa: boolean; requireMfaEnforcedAt: string | null } | null> {
  const [existing] = await db.select({
    requireMfa: servers.requireMfa,
  }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!existing) return null;

  const patch: {
    requireMfa: boolean;
    updatedAt: Date;
    requireMfaEnforcedAt?: Date | null;
  } = {
    requireMfa,
    updatedAt: new Date(),
  };
  // Enforcement timestamp anchors the grace-period deadline. Only (re)stamp
  // when toggling on from off; always clear when toggling off.
  if (requireMfa && !existing.requireMfa) {
    patch.requireMfaEnforcedAt = new Date();
  } else if (!requireMfa) {
    patch.requireMfaEnforcedAt = null;
  }

  await db.update(servers).set(patch).where(eq(servers.id, serverId));

  return {
    requireMfa,
    requireMfaEnforcedAt: patch.requireMfaEnforcedAt
      ? patch.requireMfaEnforcedAt.toISOString()
      : null,
  };
}

/**
 * Check all online servers with auto-suspend enabled and suspend those
 * that have been idle for longer than their configured timeout.
 *
 * Called on a 1-minute interval from server.ts.
 */
export async function checkAutoSuspend(): Promise<void> {
  if (!isAnyProviderConfigured()) return;

  const now = new Date();

  // Find online remote servers with auto-suspend enabled that have been idle
  const candidates = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.status, 'online'),
        eq(servers.autoSuspendEnabled, true),
        eq(servers.deploymentType, 'remote'),
        isNotNull(servers.machineId),
        isNotNull(servers.idleSince),
      )
    );

  for (const server of candidates) {
    const idleMs = now.getTime() - server.idleSince!.getTime();
    const timeoutMs = (server.autoSuspendIdleMinutes ?? 15) * 60_000;

    if (idleMs < timeoutMs) continue;

    const idleMinutes = Math.round(idleMs / 60_000);
    console.log(
      `[ServerService] Auto-suspending server ${server.id} (${server.name}) — idle for ${idleMinutes}m, timeout ${server.autoSuspendIdleMinutes}m`
    );

    try {
      const provider = getProvider((server.provider || 'fly') as ProviderId);
      await provider.suspendMachine(server.machineId!, server.flyAppName);

      // Stop billing and mark offline
      await MachineUsageService.onMachineStopped(server.id);

      await db
        .update(servers)
        .set({
          status: 'offline',
          idleSince: null,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, server.id));

      console.log(`[ServerService] Server ${server.id} suspended successfully`);
    } catch (error) {
      // If suspension fails (e.g. machine already stopped), just log and continue
      console.error(`[ServerService] Failed to auto-suspend server ${server.id}:`, error);
      // Clear idleSince so we don't retry every tick — next heartbeat will re-set it
      await db
        .update(servers)
        .set({ idleSince: null })
        .where(eq(servers.id, server.id));
    }
  }
}

/**
 * Regenerate server token
 * Returns the new plaintext token (stored as hash)
 */
export async function regenerateServerToken(
  serverId: string,
  userId: string
): Promise<{ success: boolean; serverToken?: string; error?: string }> {
  // Only owner can regenerate token
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only server owner can regenerate token' };
  }

  // Generate new token
  const serverToken = `wst_${nanoid(32)}`;
  const tokenHash = hashServerToken(serverToken);

  // Clear existing server registration (new token = new server)
  await db
    .update(servers)
    .set({
      tokenHash,
      serverUrl: null,
      status: null,
      lastSeen: null,
      updatedAt: new Date(),
    })
    .where(eq(servers.id, serverId));

  console.log(`[ServerService] Regenerated token for server ${serverId}`);
  return { success: true, serverToken };
}

// ============================================================================
// Remote Server Management (Fly.io)
// ============================================================================

/**
 * Wake a suspended remote server (internal version that accepts pre-fetched server).
 * Use this when you've already verified access and fetched the server.
 */
export async function wakeRemoteServerInternal(
  server: Server
): Promise<{ success: boolean; status?: ServerStatusType; url?: string; error?: string; wasAlreadyRunning?: boolean }> {
  const serverId = server.id;

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (!server.machineId) {
    return { success: false, error: 'No machine associated with this server' };
  }

  // Gate: refuse wake if a structural provisioning is in progress
  // (createServer, reprovision, region/tier change, migration). Without
  // this, a parallel client request — either through the explicit
  // `/wake` HTTP endpoint or any other internal caller — can race-start
  // the legacy machine mid-migration, defeating the runner's stopMachine
  // step, keeping the volume busy and stalling the snapshot. Observed
  // live during the per-app-isolation prod migration where every
  // explicit `flyctl machine stop` was reverted within ~30s by the
  // BE's wake path. The session-endpoint gate at HttpServer.ts:3899
  // covers the workspace-load flow but missed the explicit wake API.
  if (server.status === 'provisioning') {
    return { success: false, error: 'Server is being provisioned (migration / region change / etc.). Please try again once it completes.' };
  }

  // Legacy backfill: ensure remote servers have tunnel metadata and connector on the machine.
  if (!server.tunnelId) {
    try {
      await ensureServerTunnelConnector(server.id);
    } catch (error) {
      console.warn(`[ServerService] Tunnel backfill failed during wake for ${server.id}:`, error);
    }
  }

  // Check current machine status
  const provider = getProvider((server.provider || 'fly') as ProviderId);
  try {
    const machineState = await provider.getMachineState(server.machineId, server.flyAppName);

    if (machineState === 'running') {
      // Already running - no wait needed
      return { success: true, status: 'online', url: server.serverUrl || undefined, wasAlreadyRunning: true };
    }

    if (machineState === 'starting') {
      // Already starting - just wait for it to be ready
      console.log(`[ServerService] Machine ${server.machineId} is already starting, waiting...`);
      await provider.waitForState(server.machineId, ['running'], 90000, server.flyAppName);
      await provider.waitForHealthy(server.machineId, 60000, server.flyAppName);

      // Update status — clear idleSince so fresh idle tracking starts
      await db
        .update(servers)
        .set({
          status: 'online',
          lastSeen: new Date(),
          idleSince: null,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));

      return { success: true, status: 'online', url: server.serverUrl || undefined };
    }

    if (machineState === 'destroyed') {
      // Do NOT mutate the DB here. A single provider observation — even a
      // 'destroyed' state — is not authoritative: Fly's API has been seen
      // to report destroyed transiently during leader elections and proxy
      // resyncs. Auto-clearing machine_id on that signal is what disconnected
      // live servers from their DB rows and triggered cascade reprovisions.
      // Ground-truth clears belong to an explicit admin action; `/admin/servers`
      // will surface this as a 'stale' row so it can be resolved deliberately.
      console.error(
        `[ServerService] Provider reports machine ${server.machineId} as destroyed for server ${serverId}; DB left intact for admin review`
      );
      return { success: false, error: 'Machine reported destroyed by provider. Please retry or contact admin.' };
    }

    if (machineState === 'stopped' || machineState === 'suspended') {
      console.log(`[ServerService] Waking machine ${server.machineId} (state: ${machineState})`);

      // Start the machine
      await provider.startMachine(server.machineId, server.flyAppName);

      // Wait for it to be ready and healthy
      await provider.waitForState(server.machineId, ['running'], 90000, server.flyAppName);
      await provider.waitForHealthy(server.machineId, 60000, server.flyAppName);

      // Update status — clear idleSince so fresh idle tracking starts
      await db
        .update(servers)
        .set({
          status: 'online',
          lastSeen: new Date(),
          idleSince: null,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));

      return { success: true, status: 'online', url: server.serverUrl || undefined };
    }

    // Machine is in another state (stopping, etc.) - wait and retry
    console.log(`[ServerService] Machine ${server.machineId} is in ${machineState} state, waiting...`);
    await provider.waitForState(server.machineId, ['running', 'stopped', 'suspended'], 90000, server.flyAppName);

    // Retry after waiting - re-fetch server for fresh state
    const refreshed = await getServer(serverId);
    if (!refreshed) return { success: false, error: 'Server not found' };
    return wakeRemoteServerInternal(refreshed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ServerService] Failed to wake machine ${server.machineId} for server ${serverId}:`, errorMessage);
    // Never mutate the DB on a wake failure. The previous implementation
    // wiped machine_id whenever the raw error message contained the strings
    // "404" or "not found", which fires on every transient Fly API blip
    // (rate limits, proxy 404s, pooler leader elections) and was the root
    // cause of live servers being silently disconnected from their DB row.
    // The error is surfaced to the caller; recovery is an explicit user or
    // admin action, not a side effect of a single failed wake.
    return { success: false, error: `Failed to wake server: ${errorMessage}` };
  }
}

/**
 * Wake a suspended remote server (public API with access check)
 */
export async function wakeRemoteServer(
  serverId: string,
  userId: string
): Promise<{ success: boolean; status?: ServerStatusType; url?: string; error?: string; wasAlreadyRunning?: boolean }> {
  // Check access
  const hasAccess = await canAccessServer(serverId, userId);
  if (!hasAccess) {
    return { success: false, error: 'Access denied' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  return wakeRemoteServerInternal(server);
}

/**
 * Restart a remote server (stop + start the Fly.io machine)
 * Requires cloud-level owner/admin OR server RBAC administrator permission.
 */
export async function restartRemoteServer(
  serverId: string,
  userId: string
): Promise<{ success: boolean; status?: ServerStatusType; url?: string; error?: string }> {
  // Cloud-op permission: owner OR is_admin (workspace-derived mirror).
  // Reads local BE state only — works when the workspace is crashed.
  if (!(await checkCloudOpPermission(serverId, userId))) {
    return { success: false, error: 'Access denied' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (!server.machineId) {
    return { success: false, error: 'No machine associated with this server' };
  }

  try {
    await ensureServerTunnelConnector(serverId, { requireMachineUpdate: true });

    const provider = getProvider((server.provider || 'fly') as ProviderId);
    console.log(`[ServerService] Restarting machine ${server.machineId} for server ${serverId} (with image update)`);

    await provider.updateMachineImage(server.machineId, server.flyAppName);

    // Wait for it to be ready and healthy
    await provider.waitForState(server.machineId, ['running'], 30000, server.flyAppName);
    await provider.waitForHealthy(server.machineId, 45000, server.flyAppName);

    // Update status
    await db
      .update(servers)
      .set({
        status: 'online',
        lastSeen: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));

    return { success: true, status: 'online', url: server.serverUrl || undefined };
  } catch (error) {
    console.error(`[ServerService] Failed to restart machine:`, error);
    return { success: false, error: 'Failed to restart server' };
  }
}

/**
 * Update a remote server's image to :latest
 * Requires cloud-level owner/admin OR server RBAC administrator permission.
 */
export async function updateRemoteServer(
  serverId: string,
  userId: string
): Promise<{ success: boolean; status?: ServerStatusType; url?: string; error?: string }> {
  const hasCloudPerm = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasCloudPerm) {
    const hasRBACPerm = await checkServerRBACPermission(serverId, userId, 'administrator');
    if (!hasRBACPerm) {
      return { success: false, error: 'Only administrators can update the server image' };
    }
  }

  return restartRemoteServer(serverId, userId);
}

/**
 * Reprovision a remote server (after machine was destroyed).
 * Token hash is only updated in the DB once the new machine is created,
 * so the old machine can still register if provisioning fails.
 */
export async function reprovisionRemoteServer(
  serverId: string,
  userId: string
): Promise<{ success: boolean; status?: ServerStatusType; url?: string; error?: string }> {
  // Check access - only owner can reprovision
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only the server owner can reprovision' };
  }

  if (!isAnyProviderConfigured()) {
    return { success: false, error: 'Remote servers are not configured' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  // If machine already exists and isn't destroyed, just wake it
  if (server.machineId) {
    try {
      const provider = getProvider((server.provider || 'fly') as ProviderId);
      const machineState = await provider.getMachineState(server.machineId, server.flyAppName);
      if (machineState !== 'destroyed') {
        console.log(`[ServerService] Machine ${server.machineId} exists, waking instead of reprovisioning`);
        return wakeRemoteServer(serverId, userId);
      }
    } catch {
      // Machine not found - proceed with reprovisioning
      console.log(`[ServerService] Machine ${server.machineId} not found, proceeding to reprovision`);
    }
  }

  console.log(`[ServerService] Reprovisioning remote server for server ${serverId}`);

  try {
    // Generate new token but don't update the DB hash yet — provisionNewMachine
    // writes it atomically once the machine is created. This way, if provisioning
    // fails, the old machine (if still alive) can still register with the old token.
    const serverToken = generateServerToken();
    const tokenHash = hashServerToken(serverToken);

    // Mark provisioning on the status only. We intentionally do NOT pre-wipe
    // machineId / machineName / serverUrl / tunnelToken here: provisionNewMachine
    // writes those atomically once the new machine is created (see the DB update
    // inside provisionNewMachine after provider.createMachine returns). Leaving
    // the old metadata in place means a failed reprovision ends in a recoverable
    // state — the DB still points at the previous machine reference that admins
    // and the admin/servers 'stale' detector can act on — instead of a silently
    // orphaned row.
    await db
      .update(servers)
      .set({ status: 'provisioning', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    // Pass existing volumeId so reprovision reuses the same volume instead of creating a new empty one.
    // Pass through the server's existing Fly app — null for legacy (machine + volume in shared app),
    // ws-<id> for already-migrated (machine + volume in that per-tenant app). Critically, we do NOT
    // auto-promote a legacy workspace to per-tenant here: the existing volume lives in the shared
    // app and would be orphaned. Promotion is the migration tool's job.
    const result = await provisionNewMachine(
      server.id,
      serverToken,
      server.region || 'ash',
      server.tier as ServerTier | undefined,
      server.autoSuspendEnabled ?? true,
      server.volumeId,
      server.tunnelId,
      (server.provider || getDefaultProviderId()) as ProviderId,
      tokenHash,
      server.flyAppName,
      server.flyNetworkName,
    );

    return { success: true, status: 'online', url: result.url };
  } catch (error) {
    console.error(`[ServerService] Failed to reprovision remote server:`, error);

    // Update status to offline (not 'error') so retry is possible
    await db
      .update(servers)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    return { success: false, error: 'Failed to reprovision server' };
  }
}

/**
 * Validate a region change request without performing it.
 * Used to return fast validation errors before starting the async operation.
 */
export async function validateChangeRegion(
  serverId: string,
  userId: string,
  region: string
): Promise<{ success: boolean; error?: string }> {
  const VALID_REGIONS = ['iad', 'ams', 'sin', 'gru'];
  if (!VALID_REGIONS.includes(region)) {
    return { success: false, error: `Invalid region. Must be one of: ${VALID_REGIONS.join(', ')}` };
  }

  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only server owner can change region' };
  }

  if (!isAnyProviderConfigured()) {
    return { success: false, error: 'Remote servers are not configured' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (server.region === region) {
    return { success: false, error: 'Server is already in this region' };
  }

  if (server.status === 'provisioning') {
    return { success: false, error: 'Server is already being provisioned' };
  }

  return { success: true };
}

// ============================================================================
// Per-tenant Fly app migration
// ============================================================================

export interface MigrationResult {
  serverId: string;
  oldAppName: string;
  newAppName: string;
  oldMachineId: string;
  newMachineId: string;
  oldVolumeId: string;
  newVolumeId: string;
  snapshotId: string;
  durationMs: number;
}

/**
 * Return server IDs that still live on the legacy shared Fly app
 * (i.e. `flyAppName IS NULL`). Drives the bulk-migration runner.
 */
export async function listLegacyWorkspaceServerIds(): Promise<Array<{
  id: string;
  name: string;
  status: ServerStatusType | null;
  region: string | null;
  machineId: string | null;
  volumeId: string | null;
}>> {
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      status: servers.status,
      region: servers.region,
      machineId: servers.machineId,
      volumeId: servers.volumeId,
    })
    .from(servers)
    .where(and(
      eq(servers.deploymentType, 'remote'),
      isNull(servers.flyAppName),
    ));
  return rows;
}

/**
 * Migrate a legacy workspace from the shared Fly app to its own per-tenant
 * app on a dedicated 6PN network (see docs/per-app-isolation-migration.md).
 *
 * Fly does not allow changing an app's network in-place, so the migration
 * must recreate the machine + volume under a new app:
 *
 *   1. Stop the old machine cleanly so the volume snapshot is consistent.
 *   2. Snapshot the old volume.
 *   3. Create the new per-tenant app + network.
 *   4. Restore the snapshot as a new volume in the new app.
 *   5. Provision a new machine in the new app, mounting the restored volume.
 *      `provisionNewMachine` (Phase 2) already wires up the per-tenant app
 *      and persists `flyAppName` / `flyNetworkName` on the server row, so
 *      step 5 is the atomic cutover point: until it returns, the DB still
 *      points at the old (now-stopped) machine and we can safely abort.
 *   6. Delete old machine + volume from the shared app.
 *
 * Per-workspace downtime ≈ 2–3 minutes (between step 1 and step 5 succeeding).
 *
 * Idempotent on retry where it can be: createApp is idempotent, and
 * `provisionNewMachine` will reuse the restored volume by id. If the
 * function fails after step 5 but before step 6, the next invocation will
 * see `flyAppName` populated and short-circuit (already migrated) — leaving
 * a stale old machine + volume that an operator can reap manually.
 */
export async function migrateWorkspaceToOwnApp(serverId: string): Promise<MigrationResult> {
  const startedAt = Date.now();
  const server = await getServer(serverId);
  if (!server) {
    throw new Error(`Server ${serverId} not found`);
  }
  if (server.deploymentType !== 'remote') {
    throw new Error(`Server ${serverId} is not a remote workspace`);
  }
  if (server.flyAppName) {
    throw new Error(`Server ${serverId} is already on per-tenant app ${server.flyAppName}; nothing to migrate`);
  }
  if (!server.machineId || !server.volumeId) {
    throw new Error(`Server ${serverId} has no machine or volume to migrate from`);
  }

  const oldMachineId = server.machineId;
  const oldVolumeId = server.volumeId;
  const region = server.region || 'iad';
  const oldAppName = process.env.SERVER_APP || process.env.FLY_APP_NAME || 'fishtank-workspaces';
  const newAppName = workspaceAppName(serverId);
  const newNetworkName = workspaceNetworkName(serverId);
  const provider = getProvider((server.provider || 'fly') as ProviderId);

  console.log(`[ServerService] Migrating ${serverId} from ${oldAppName} to ${newAppName}`);

  // Gate concurrent traffic for the duration of the migration. The session
  // endpoint blocks wakes when status === 'provisioning'; without this flip,
  // a user request mid-migration would call wakeRemoteServerInternal →
  // startMachine on the legacy machine after the snapshot was already taken,
  // and any writes the user makes between then and cutover would land only
  // in the old volume and disappear when migration completes. changeRegion
  // and changeTier already use this gate; migration does the same.
  await db
    .update(servers)
    .set({ status: 'provisioning', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  // Track partial state so a single outer recovery handler knows what to
  // clean up depending on which step threw. ANY failure between this point
  // and a successful provisionNewMachine() must drop the provisioning gate
  // we just set, otherwise the workspace is permanently un-wakeable and
  // operators have to intervene by hand.
  let snapshot: { id: string } | undefined;
  let appCreated = false;
  let newVolume: VolumeInfo | undefined;
  let provisionResult: { machineId: string; machineName: string; url: string; region: string; volumeId: string } | undefined;

  try {
    // Stop billing for the old machine before we begin teardown — we'll start a
    // fresh tick for the new machine via provisionNewMachine.
    await MachineUsageService.onMachineStopped(serverId);

    // 1. Stop the old machine so the volume is quiesced before snapshot.
    //
    // `disableAutostart: true` is critical here. Workspace machines have
    // `autostart: true` on their services so Fly's edge auto-wakes them
    // on incoming traffic. An open browser tab pointed at the workspace
    // (WebSocket, terminal, file editor, preview port) keeps generating
    // traffic, which would race-restart the machine mid-snapshot — the
    // volume would never quiesce, Fly's snapshot stays in `running`
    // state past our poll timeout, and step 4 fails with "snapshot not
    // found". Disabling autostart makes the stop durable for the
    // duration of the snapshot. The machine is deleted at step 7
    // anyway, so we don't need to restore the flag.
    //
    // 5-min waitForState cap matches the broader timeout chain — Fly
    // can be slow to actually stop machines during regional congestion.
    // Throwing on timeout (rather than warn-and-proceed) is intentional:
    // taking a snapshot of a not-fully-quiesced volume risks data
    // inconsistency in the migration target. Better to abort cleanly
    // via the recovery path and retry than corrupt the new volume.
    await provider.stopMachine(oldMachineId, oldAppName, { disableAutostart: true });
    await provider.waitForState(oldMachineId, ['stopped'], 300_000, oldAppName);

    // 2. Snapshot old volume. createSnapshot polls until ready (~1–2 min).
    snapshot = await provider.createSnapshot(oldVolumeId, oldAppName);
    console.log(`[ServerService] Snapshotted ${oldVolumeId} → ${snapshot.id}`);

    // 3. Create per-tenant app + network. Idempotent; safe to retry.
    await provider.createApp(newAppName, newNetworkName);
    appCreated = true;

    // 4. Restore the snapshot as a new volume inside the new app.
    const oldVolume = await provider.getVolume(oldVolumeId, oldAppName);
    const sizeGb = oldVolume?.sizeGb ?? 1;
    const sanitizedId = serverId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    newVolume = await provider.createVolumeFromSnapshot(
      snapshot.id,
      `data_${sanitizedId}`,
      region,
      sizeGb,
      newAppName,
    );
    console.log(`[ServerService] Restored snapshot into ${newVolume.id} (${newAppName})`);

    // 4b. Wait for the restored volume to finish hydrating before
    // mounting it. createVolumeFromSnapshot returns the volume ID
    // immediately; Fly populates the data in the background, with the
    // volume's `state` field staying `restoring` until done.
    //
    // Without this wait, the next step's call into provisionNewMachine
    // → getOrCreateVolume would see `state !== 'created'` and create a
    // fresh EMPTY volume instead, silently dropping the restored data
    // — observed once on a staging migration where the new machine
    // ended up mounted on an empty 40 GiB volume while the actual
    // restored data sat orphaned in a different (created-state)
    // volume. See docs/per-app-isolation-migration.md and the
    // commit message for ServerService waitForVolumeReady wiring.
    await provider.waitForVolumeReady(newVolume.id, newAppName);

    // 5. Provision a new machine in the new app, mounting the restored volume.
    // The new app was already created in step 3; provisionNewMachine consumes
    // newAppName / newNetworkName as the target. It writes the new
    // machineId / volumeId / flyAppName / flyNetworkName / tokenHash to the
    // server row immediately on createMachine success and BEFORE the
    // wait-for-healthy steps — the outer catch below uses the row's
    // flyAppName to detect whether the cutover crossed that line.
    const newToken = generateServerToken();
    const newTokenHash = hashServerToken(newToken);

    provisionResult = await provisionNewMachine(
      serverId,
      newToken,
      region,
      server.tier as ServerTier | undefined,
      server.autoSuspendEnabled ?? true,
      newVolume.id,
      server.tunnelId,
      (server.provider || 'fly') as ProviderId,
      newTokenHash,
      newAppName,
      newNetworkName,
    );
  } catch (err) {
    console.error(`[ServerService] Migration failed for ${serverId} after status=provisioning:`, err);

    // Recovery splits into two cases based on whether the provisionNewMachine
    // DB write happened (cutover):
    //
    //   POST-cutover (refreshed.flyAppName === newAppName): the row already
    //   references the new machine + new app + rotated tokenHash. Deleting
    //   the new resources here would brick the workspace AND make it invisible
    //   to retry runs (legacy-workspaces query filters on flyAppName IS NULL).
    //   Leave everything intact, leave status='provisioning', surface a loud
    //   warning so an operator inspects the new machine manually. Old machine
    //   + volume in the shared app remain as a fallback.
    //
    //   PRE-cutover (everything else — including throws from onMachineStopped,
    //   createSnapshot, createApp, createVolumeFromSnapshot, or provisionNewMachine
    //   before its DB write): the row still references the old machine. Best-
    //   effort delete any partial new resources we created (volume, app),
    //   then drop the provisioning gate to status='offline' so the user can
    //   wake the still-intact old machine in the shared app.
    const refreshed = await getServer(serverId);
    if (refreshed?.flyAppName === newAppName) {
      console.error(
        `[ServerService] Migration POST-CUTOVER failure for ${serverId}: ` +
        `DB row already points at ${newAppName} (machine ${refreshed.machineId}). ` +
        `New machine likely unhealthy. NOT deleting new resources. ` +
        `Old machine ${oldMachineId} and volume ${oldVolumeId} remain in ${oldAppName} as fallback. ` +
        `Status remains 'provisioning' so the workspace is gated until an operator investigates.`
      );
      throw err;
    }

    if (newVolume) {
      try {
        await provider.deleteVolume(newVolume.id, newAppName);
      } catch (e) { console.warn(`[ServerService]   cleanup deleteVolume(${newVolume.id}) failed: ${e}`); }
    }
    if (appCreated) {
      try {
        await provider.deleteApp(newAppName);
      } catch (e) { console.warn(`[ServerService]   cleanup deleteApp(${newAppName}) failed: ${e}`); }
    }
    // Note: orphaned snapshot (when failure happens between createSnapshot
    // and createApp) is left for Fly's default retention to reap (~5 days).
    // We don't have a deleteSnapshot in the provider abstraction yet.

    await db
      .update(servers)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    throw err;
  }

  // 6. Delete old machine + volume from the shared app. Independent of each
  // other and best-effort: a failure here just leaks resources, the
  // workspace itself is already on the new app.
  try {
    await provider.deleteMachine(oldMachineId, oldAppName);
    console.log(`[ServerService] Deleted old machine ${oldMachineId}`);
  } catch (err) {
    console.error(`[ServerService] Failed to delete old machine ${oldMachineId}:`, err);
  }
  try {
    await provider.deleteVolume(oldVolumeId, oldAppName);
    console.log(`[ServerService] Deleted old volume ${oldVolumeId}`);
  } catch (err) {
    console.error(`[ServerService] Failed to delete old volume ${oldVolumeId}:`, err);
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[ServerService] Migration complete for ${serverId}: ${oldAppName} → ${newAppName} in ${Math.round(durationMs / 1000)}s`);

  return {
    serverId,
    oldAppName,
    newAppName,
    oldMachineId,
    newMachineId: provisionResult.machineId,
    oldVolumeId,
    newVolumeId: newVolume.id,
    snapshotId: snapshot.id,
    durationMs,
  };
}

/**
 * Create a workspace in legacy shape — provisioned in the shared Fly app
 * (`runhq-workspaces-staging` / `fishtank-workspaces`) with `fly_app_name`
 * NULL on the row, exactly like a pre-Phase-2 workspace. Lets operators
 * synthesize a migration target without redeploying master, so the
 * `migrateWorkspaceToOwnApp` flow can be tested end-to-end on staging
 * without disturbing already-migrated workspaces in the same env.
 *
 * Synchronous (awaits provisioning, unlike `createServer` which fires
 * provisioning in the background with .catch). The admin caller wants
 * to know whether the legacy machine actually came up before they try
 * to migrate it.
 *
 * Skips the Stripe subscription gate that `createServer` enforces —
 * this is an admin/operator path, not a self-serve user flow.
 */
export async function createLegacyTestServer(
  ownerId: string,
  name: string,
  region: string = 'iad',
  tier: ServerTier = 'shared-cpu-4x' as ServerTier,
): Promise<{ serverId: string; machineId: string; serverUrl: string }> {
  const serverId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const serverToken = generateServerToken();
  const tokenHash = hashServerToken(serverToken);

  // Row is inserted with fly_app_name=NULL — that's what makes this a
  // legacy-shape workspace. provisionNewMachine called with null flyAppName
  // routes the machine into the env-default (shared) app and uses the
  // legacy CloudflareTunnel.createDnsRecord ingress flow rather than the
  // per-tenant CNAME flow.
  await db.insert(servers).values({
    id: serverId,
    name,
    ownerId,
    tokenHash,
    deploymentType: 'remote',
    provider: 'fly',
    tier,
    region,
    autoSuspendEnabled: true,
    status: 'provisioning',
    flyAppName: null,
    flyNetworkName: null,
  });

  await db.insert(serverMembers).values({
    serverId,
    userId: ownerId,
    role: 'owner',
  });

  console.log(`[ServerService] Created LEGACY test server ${serverId} for user ${ownerId} in shared Fly app`);

  try {
    const result = await provisionNewMachine(
      serverId,
      serverToken,
      region,
      tier,
      true,
      undefined,
      undefined,
      'fly',
      undefined,
      null, // flyAppName=null → legacy shared-app provisioning
      null, // flyNetworkName=null
    );
    console.log(`[ServerService] LEGACY test server ${serverId} provisioned: machine ${result.machineId} at ${result.url}`);
    return {
      serverId,
      machineId: result.machineId,
      serverUrl: result.url,
    };
  } catch (err) {
    await db
      .update(servers)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(servers.id, serverId));
    throw err;
  }
}

/**
 * Change the region of a remote server.
 * Forks the existing volume to the new region (preserving all data),
 * creates a new machine there, then cleans up old infrastructure.
 */
export async function changeRegion(
  serverId: string,
  userId: string,
  region: string
): Promise<{ success: boolean; region?: string; status?: ServerStatusType; error?: string }> {
  // Owner-only permission check
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only server owner can change region' };
  }

  if (!isAnyProviderConfigured()) {
    return { success: false, error: 'Remote servers are not configured' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (server.region === region) {
    return { success: false, error: 'Server is already in this region' };
  }

  const provider = getProvider((server.provider || 'fly') as ProviderId);

  // Validate region for the server's provider
  const validRegions = provider.getRegions().map(r => r.id);
  if (!validRegions.includes(region)) {
    return { success: false, error: `Invalid region for ${provider.id}. Must be one of: ${validRegions.join(', ')}` };
  }
  console.log(`[ServerService] Changing region for server ${serverId} from ${server.region} to ${region}`);

  // Stop machine billing before destroying
  await MachineUsageService.onMachineStopped(serverId);

  // Set status to provisioning
  await db
    .update(servers)
    .set({ status: 'provisioning', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  const oldMachineId = server.machineId;
  const oldVolumeId = server.volumeId;

  try {
    // Fork volume to new region (preserves all data via block-level copy)
    let forkedVolumeId: string | undefined;
    if (oldVolumeId) {
      const sanitizedId = serverId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
      const volumeName = `data_${sanitizedId}`;
      const oldVolume = await provider.getVolume(oldVolumeId, server.flyAppName);
      const sizeGb = oldVolume?.sizeGb || 1;

      const forkedVolume = await provider.forkVolume(oldVolumeId, volumeName, region, sizeGb, server.flyAppName);
      forkedVolumeId = forkedVolume.id;
      console.log(`[ServerService] Forked volume ${oldVolumeId} -> ${forkedVolumeId} in ${region}`);
    }

    // Stop old machine (don't delete yet — volume fork may still be hydrating from source)
    if (oldMachineId) {
      try {
        await provider.stopMachine(oldMachineId, server.flyAppName);
      } catch {
        // Machine may already be stopped
      }
      console.log(`[ServerService] Stopped old machine ${oldMachineId}`);
    }

    // Generate new token but defer DB hash update until machine is created
    const serverToken = generateServerToken();
    const tokenHash = hashServerToken(serverToken);

    // Only bump region — a non-destructive metadata update. We deliberately
    // leave machineId / machineName / volumeId / serverUrl / tunnelToken
    // pointing at the old (now-stopped) machine so that if provisionNewMachine
    // throws, recovery is still possible: the old machine can be restarted
    // and the forked volume cleaned up, instead of the server being stranded
    // with NULL metadata. provisionNewMachine writes the new machine's values
    // atomically only after it is up and healthy.
    await db
      .update(servers)
      .set({ region: region, updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    // Create new machine in new region with forked volume. forkVolume is intra-app
    // (Fly's source_volume_id requires same app), so the forked volume lives in
    // server.flyAppName — we pass that through so the new machine targets the
    // same app as the volume. Legacy (null) → shared app; per-tenant → ws-<id>.
    const result = await provisionNewMachine(
      server.id,
      serverToken,
      region,
      server.tier as ServerTier | undefined,
      server.autoSuspendEnabled ?? true,
      forkedVolumeId,
      server.tunnelId,
      (server.provider || getDefaultProviderId()) as ProviderId,
      tokenHash,
      server.flyAppName,
      server.flyNetworkName,
    );

    console.log(`[ServerService] Region changed to ${region}, new machine at ${result.url}`);

    // Clean up old infrastructure after new machine is healthy.
    // Old machine + volume live in the same per-tenant Fly app (workspaceAppName
    // is deterministic from serverId, so changeRegion reuses the same app).
    if (oldMachineId) {
      try {
        await provider.deleteMachine(oldMachineId, server.flyAppName);
        console.log(`[ServerService] Deleted old machine ${oldMachineId}`);
      } catch (cleanupError) {
        console.error(`[ServerService] Failed to delete old machine ${oldMachineId}:`, cleanupError);
      }
    }
    if (oldVolumeId) {
      try {
        await provider.deleteVolume(oldVolumeId, server.flyAppName);
        console.log(`[ServerService] Deleted old volume ${oldVolumeId}`);
      } catch (cleanupError) {
        console.error(`[ServerService] Failed to delete old volume ${oldVolumeId}:`, cleanupError);
      }
    }

    return { success: true, region: result.region, status: 'online' };
  } catch (error) {
    console.error(`[ServerService] Failed to change region:`, error);

    await db
      .update(servers)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    return { success: false, error: 'Failed to change region' };
  }
}

/**
 * Validate a tier change request (sync check before background operation).
 */
export async function validateChangeTier(
  serverId: string,
  userId: string,
  newTier: string
): Promise<{ success: boolean; error?: string; diskUsage?: { usedBytes: number; totalBytes: number } }> {
  const VALID_TIERS = [
    // New tiers
    'shared-4x-1gb', 'shared-4x-2gb', 'shared-4x-4gb', 'shared-4x-8gb',
    'shared-8x-4gb', 'shared-8x-8gb', 'shared-8x-16gb',
    'perf-2x-4gb', 'perf-2x-8gb', 'perf-2x-16gb',
    'perf-4x-8gb', 'perf-4x-16gb', 'perf-4x-32gb',
    // Legacy tiers (still accepted for backward compat)
    'micro', 'small', 'medium', 'large', 'xlarge', 'xxlarge',
    'shared-cpu-1x', 'shared-cpu-2x', 'shared-cpu-4x', 'performance-cpu-2x', 'performance-cpu-4x',
  ];
  if (!VALID_TIERS.includes(newTier)) {
    return { success: false, error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}` };
  }

  const hasCloudPerm = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasCloudPerm) {
    const hasRBACPerm = await checkServerRBACPermission(serverId, userId, 'administrator');
    if (!hasRBACPerm) {
      return { success: false, error: 'Only administrators can change tier' };
    }
  }

  if (!isAnyProviderConfigured()) {
    return { success: false, error: 'Remote servers are not configured' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (server.tier === newTier) {
    return { success: false, error: 'Server is already on this tier' };
  }

  if (server.status === 'provisioning') {
    return { success: false, error: 'Server is already being provisioned' };
  }

  // Block downgrades — Fly.io doesn't support shrinking volumes
  const provider = getProvider((server.provider || 'fly') as ProviderId);
  const newTierId = flyTierToTierId(newTier as ServerTier);
  const newTierSpec = provider.getTierSpecs().find(t => t.tierId === newTierId);
  const newDiskGb = newTierSpec?.diskGb || 1;

  const currentTierId = server.tier ? flyTierToTierId(server.tier as ServerTier) : 'micro';
  const currentTierSpec = provider.getTierSpecs().find(t => t.tierId === currentTierId);
  const currentDiskGb = currentTierSpec?.diskGb || 1;

  if (newDiskGb < currentDiskGb) {
    return { success: false, error: 'Downgrading to a smaller tier is not supported. Please contact support if you need to downgrade.' };
  }

  return { success: true };
}

/**
 * Change server tier (resize machine).
 * Destroys old machine/volume, creates new ones with new tier specs.
 * Volume is snapshotted before deletion for safety.
 */
export async function changeTier(
  serverId: string,
  userId: string,
  newTier: ServerTier
): Promise<{ success: boolean; tier?: ServerTier; status?: ServerStatusType; error?: string }> {
  const VALID_TIERS: ServerTier[] = [
    // New tiers
    'shared-4x-1gb', 'shared-4x-2gb', 'shared-4x-4gb', 'shared-4x-8gb',
    'shared-8x-4gb', 'shared-8x-8gb', 'shared-8x-16gb',
    'perf-2x-4gb', 'perf-2x-8gb', 'perf-2x-16gb',
    'perf-4x-8gb', 'perf-4x-16gb', 'perf-4x-32gb',
    // Legacy tiers (still accepted for backward compat)
    'micro', 'small', 'medium', 'large', 'xlarge', 'xxlarge',
    'shared-cpu-1x', 'shared-cpu-2x', 'shared-cpu-4x', 'performance-cpu-2x', 'performance-cpu-4x',
  ];
  if (!VALID_TIERS.includes(newTier)) {
    return { success: false, error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}` };
  }

  const hasCloudPerm = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasCloudPerm) {
    const hasRBACPerm = await checkServerRBACPermission(serverId, userId, 'administrator');
    if (!hasRBACPerm) {
      return { success: false, error: 'Only administrators can change tier' };
    }
  }

  if (!isAnyProviderConfigured()) {
    return { success: false, error: 'Remote servers are not configured' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (server.deploymentType !== 'remote') {
    return { success: false, error: 'Not a remote server' };
  }

  if (server.tier === newTier) {
    return { success: false, error: 'Server is already on this tier' };
  }

  const provider = getProvider((server.provider || 'fly') as ProviderId);
  console.log(`[ServerService] Changing tier for server ${serverId} from ${server.tier} to ${newTier}`);

  // Stop machine billing before destroying
  await MachineUsageService.onMachineStopped(serverId);

  // Set status to provisioning
  await db
    .update(servers)
    .set({ status: 'provisioning', updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  const oldMachineId = server.machineId;
  const oldVolumeId = server.volumeId;
  const region = server.region || 'ash';

  try {
    // Stop and delete old machine (must be stopped before volume can be reattached)
    if (oldMachineId) {
      try {
        await provider.stopMachine(oldMachineId, server.flyAppName);
      } catch {
        // Machine may already be stopped
      }
      await provider.deleteMachine(oldMachineId, server.flyAppName);
      console.log(`[ServerService] Deleted old machine ${oldMachineId}`);
    }

    // Handle volume: upgrade via snapshot, same size reuses existing volume
    // Extend volume if upgrading to a larger disk (downgrades blocked in validateChangeTier)
    const volumeIdForNewMachine = oldVolumeId;
    if (oldVolumeId) {
      const tierId = flyTierToTierId(newTier);
      const tierSpec = provider.getTierSpecs().find(t => t.tierId === tierId);
      const newSizeGb = tierSpec?.diskGb || 1;

      const currentVolume = await provider.getVolume(oldVolumeId, server.flyAppName);
      const currentSizeGb = currentVolume?.sizeGb || 0;

      if (newSizeGb > currentSizeGb) {
        console.log(`[ServerService] Extending volume ${oldVolumeId} from ${currentSizeGb}GB to ${newSizeGb}GB`);
        await provider.extendVolume(oldVolumeId, newSizeGb, server.flyAppName);
        console.log(`[ServerService] Volume extended successfully`);
      } else {
        console.log(`[ServerService] Reusing existing volume ${oldVolumeId} (${currentSizeGb}GB)`);
      }
    }

    // Generate new token but defer DB hash update until machine is created
    const serverToken = generateServerToken();
    const tokenHash = hashServerToken(serverToken);

    // Bump tier only — a non-destructive metadata update. The old machineId
    // has already been deleted at the provider (required to free the volume
    // for reattach), but we deliberately leave the DB row pointing at it:
    // provisionNewMachine writes the new machine's metadata atomically once
    // it is healthy, and on failure the admin 'stale' detector surfaces the
    // stranded reference so an explicit reprovision can rebuild against the
    // preserved volumeId. Wiping to NULL made the row indistinguishable from
    // a never-provisioned server.
    await db
      .update(servers)
      .set({ tier: newTier, updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    // Create new machine with new tier, reusing volume. Volume + new machine
    // must live in the same Fly app — pass server.flyAppName through so the
    // legacy workspace stays on the shared app and the per-tenant workspace
    // stays on ws-<id>. Same constraint as changeRegion above.
    const result = await provisionNewMachine(
      server.id,
      serverToken,
      region,
      newTier,
      server.autoSuspendEnabled ?? true,
      volumeIdForNewMachine,
      server.tunnelId,
      (server.provider || getDefaultProviderId()) as ProviderId,
      tokenHash,
      server.flyAppName,
      server.flyNetworkName,
    );

    console.log(`[ServerService] Tier changed to ${newTier}, new machine at ${result.url}`);
    return { success: true, tier: newTier, status: 'online' };
  } catch (error) {
    console.error(`[ServerService] Failed to change tier:`, error);

    // Preserve volumeId so reprovision can recover by reusing the existing volume
    await db
      .update(servers)
      .set({ status: 'error', volumeId: oldVolumeId, updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    return { success: false, error: 'Failed to change tier' };
  }
}

/**
 * Extend a server's volume to a new size (owner/admin only, cannot shrink)
 */
export async function extendServerVolume(
  serverId: string,
  userId: string,
  newSizeGb: number
): Promise<{ success: boolean; error?: string; newSizeGb?: number }> {
  const hasAccess = await canAccessServer(serverId, userId);
  if (!hasAccess) {
    return { success: false, error: 'Access denied' };
  }

  // Check owner only
  const hasPermission = await checkServerPermission(serverId, userId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only the server owner can extend the volume' };
  }

  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }

  if (!server.volumeId) {
    return { success: false, error: 'Server has no volume' };
  }

  if (server.provider !== 'fly') {
    return { success: false, error: 'Volume extension is only supported for Fly.io servers' };
  }

  if (!Number.isInteger(newSizeGb) || newSizeGb < 1 || newSizeGb > 500) {
    return { success: false, error: 'Invalid size. Must be between 1 and 500 GB.' };
  }

  const provider = getProvider(server.provider as ProviderId);
  const currentVolume = await provider.getVolume(server.volumeId, server.flyAppName);
  if (!currentVolume) {
    return { success: false, error: 'Volume not found' };
  }

  if (newSizeGb <= currentVolume.sizeGb) {
    return { success: false, error: `New size must be larger than current size (${currentVolume.sizeGb} GB). Volumes cannot be shrunk.` };
  }

  try {
    await provider.extendVolume(server.volumeId, newSizeGb, server.flyAppName);
    console.log(`[ServerService] Extended volume for server ${serverId} from ${currentVolume.sizeGb}GB to ${newSizeGb}GB`);
    return { success: true, newSizeGb };
  } catch (err) {
    console.error(`[ServerService] Failed to extend volume for server ${serverId}:`, err);
    return { success: false, error: 'Failed to extend volume' };
  }
}

/**
 * Get remote server status from Fly.io
 */
export async function getRemoteServerStatus(
  serverId: string,
  userId: string
): Promise<{ status: ServerStatusType; machineState?: string; url?: string } | null> {
  const hasAccess = await canAccessServer(serverId, userId);
  if (!hasAccess) {
    return null;
  }

  const server = await getServer(serverId);
  if (!server || server.deploymentType !== 'remote' || !server.machineId) {
    return null;
  }

  try {
    const provider = getProvider((server.provider || 'fly') as ProviderId);
    const machineState = await provider.getMachineState(server.machineId, server.flyAppName);

    // Map normalized machine state to our status
    let status: ServerStatusType;
    switch (machineState) {
      case 'running':
        status = 'online';
        break;
      case 'suspended':
        status = 'suspended';
        break;
      case 'stopped':
        status = 'offline';
        break;
      case 'starting':
      case 'creating':
        status = 'provisioning';
        break;
      default:
        status = 'offline';
    }

    // Update server status if different
    if (server.status !== status) {
      await db
        .update(servers)
        .set({ status, updatedAt: new Date() })
        .where(eq(servers.id, serverId));
    }

    return {
      status,
      machineState,
      url: server.serverUrl || undefined,
    };
  } catch (error) {
    console.error(`[ServerService] Failed to get machine status:`, error);
    return { status: 'error' };
  }
}

/**
 * Delete a remote server (machine + volume)
 */
export async function deleteRemoteServer(serverId: string): Promise<boolean> {
  const server = await getServer(serverId);
  if (!server || server.deploymentType !== 'remote') {
    return false;
  }

  // Stop machine billing before deletion
  await MachineUsageService.onMachineStopped(serverId);

  const provider = getProvider((server.provider || 'fly') as ProviderId);
  let success = true;

  // Snapshot volume before deletion (safety net for data recovery)
  if (server.volumeId) {
    try {
      const snapshot = await provider.createSnapshot(server.volumeId, server.flyAppName);
      console.log(`[ServerService] Created snapshot ${snapshot.id} of volume ${server.volumeId} before deletion`);
    } catch (snapshotError) {
      console.error(`[ServerService] Failed to snapshot volume before deletion:`, snapshotError);
    }
  }

  // Delete machine (independent — don't let failure skip volume cleanup)
  if (server.machineId) {
    try {
      console.log(`[ServerService] Deleting machine ${server.machineId} (provider: ${server.provider})`);
      await provider.deleteMachine(server.machineId, server.flyAppName);
      console.log(`[ServerService] Machine ${server.machineId} deleted`);
    } catch (error) {
      console.error(`[ServerService] Failed to delete machine ${server.machineId}:`, error);
      success = false;
    }
  }

  // Delete volume (independent — always attempt even if machine delete failed)
  if (server.volumeId) {
    try {
      console.log(`[ServerService] Deleting volume ${server.volumeId} (provider: ${server.provider})`);
      await provider.deleteVolume(server.volumeId, server.flyAppName);
      console.log(`[ServerService] Volume ${server.volumeId} deleted`);
    } catch (error) {
      console.error(`[ServerService] Failed to delete volume ${server.volumeId}:`, error);
      success = false;
    }
  }

  // Delete the per-tenant Fly app shell after machine + volume are gone. Only
  // applies to workspaces that were provisioned under per-app isolation;
  // legacy machines (flyAppName=null) lived in the shared app and we leave
  // that alone. Idempotent — a 404 (already deleted) is treated as success
  // by FlyService.deleteApp.
  if (server.flyAppName) {
    try {
      console.log(`[ServerService] Deleting per-tenant Fly app ${server.flyAppName}`);
      await provider.deleteApp(server.flyAppName);
      console.log(`[ServerService] App ${server.flyAppName} deleted`);
    } catch (error) {
      console.error(`[ServerService] Failed to delete app ${server.flyAppName}:`, error);
      success = false;
    }
  }

  return success;
}

/**
 * Check if user can access a server by serverId
 */
export async function checkServerAccess(
  userId: string,
  serverId: string
): Promise<{ hasAccess: boolean; role?: string }> {
  const [membership] = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId)
    ))
    .limit(1);

  if (!membership) {
    return { hasAccess: false };
  }

  return { hasAccess: true, role: membership.role };
}

// ============================================================================
// Bans
// ============================================================================

export async function banMember(serverId: string, requesterId: string, targetUserId: string, reason?: string, deleteMessageHours?: number): Promise<boolean> {
  // Only owner can ban members
  const hasPermission = await checkServerPermission(serverId, requesterId, ['owner']);
  if (!hasPermission) return false;

  const server = await getServer(serverId);
  if (!server || server.ownerId === targetUserId) return false;

  // Insert ban record
  await db.insert(serverBans).values({
    serverId,
    userId: targetUserId,
    reason: reason || null,
    bannedById: requesterId,
  });

  // Also remove from members (kick + ban)
  await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, targetUserId)));

  // Purge messages on the RunHQ server if requested
  if (deleteMessageHours && deleteMessageHours > 0) {
    try {
      const { url, headers } = await buildServerFetchHeaders(server, requesterId);
      const since = new Date(Date.now() - deleteMessageHours * 60 * 60 * 1000).toISOString();
      await fetch(`${url}/api/chat/purge-user-messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId: targetUserId, since }),
      });
    } catch (err) {
      console.error(`[ServerService] Failed to purge messages for banned user ${targetUserId}:`, err);
    }
  }

  console.log(`[ServerService] Banned user ${targetUserId} from server ${serverId}${deleteMessageHours ? ` (purging ${deleteMessageHours}h of messages)` : ''}`);
  return true;
}

export async function unbanMember(serverId: string, requesterId: string, targetUserId: string): Promise<boolean> {
  const hasPermission = await checkServerPermission(serverId, requesterId, ['owner']);
  if (!hasPermission) return false;

  await db
    .delete(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, targetUserId)));

  console.log(`[ServerService] Unbanned user ${targetUserId} from server ${serverId}`);
  return true;
}

export async function isUserBanned(serverId: string, userId: string): Promise<boolean> {
  const [ban] = await db
    .select({ id: serverBans.id })
    .from(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)))
    .limit(1);
  return !!ban;
}

export async function getServerBans(serverId: string): Promise<Array<{
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  reason: string | null;
  bannedById: string;
  createdAt: Date;
}>> {
  const bans = await db
    .select({
      id: serverBans.id,
      userId: serverBans.userId,
      userName: users.name,
      userEmail: users.email,
      reason: serverBans.reason,
      bannedById: serverBans.bannedById,
      createdAt: serverBans.createdAt,
    })
    .from(serverBans)
    .innerJoin(users, eq(serverBans.userId, users.id))
    .where(eq(serverBans.serverId, serverId));
  return bans;
}

// ============================================================================
// Ownership Transfer
// ============================================================================

/**
 * Transfer server ownership to another user (by email).
 * Validates recipient exists, isn't already the owner, and hasn't hit their server limit.
 * On success: recipient becomes owner, old owner becomes admin.
 */
export async function transferOwnership(
  serverId: string,
  currentOwnerId: string,
  newOwnerEmail: string
): Promise<{ success: boolean; error?: string }> {
  // Verify server exists and current user is the owner
  const server = await getServer(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }
  if (server.ownerId !== currentOwnerId) {
    return { success: false, error: 'Only the server owner can transfer ownership' };
  }

  // Look up recipient by email
  const recipient = await getUserByEmail(newOwnerEmail.toLowerCase());
  if (!recipient) {
    return { success: false, error: 'No account found with that email' };
  }

  // Can't transfer to yourself
  if (recipient.id === currentOwnerId) {
    return { success: false, error: 'You already own this server' };
  }

  // Check recipient's server limit (admins bypass)
  const recipientIsAdmin = await isAdmin(recipient.id);
  if (!recipientIsAdmin) {
    const subscription = await getOrCreateSubscription(recipient.id);
    const planId = subscription.planId as keyof typeof PLAN_CONFIG;
    const planConfig = PLAN_CONFIG[planId] || PLAN_CONFIG.free;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(servers)
      .where(eq(servers.ownerId, recipient.id));
    const ownedCount = Number(countResult?.count ?? 0);

    if (ownedCount >= planConfig.maxServers) {
      return {
        success: false,
        error: `Recipient has reached their server limit (${ownedCount}/${planConfig.maxServers} on ${planConfig.name} plan). They need to upgrade or free up a server.`,
      };
    }
  }

  // Execute the transfer
  // 1. Update server owner
  await db
    .update(servers)
    .set({ ownerId: recipient.id, updatedAt: new Date() })
    .where(eq(servers.id, serverId));

  // 2. Check if recipient is already a member
  const [existingMembership] = await db
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, recipient.id)))
    .limit(1);

  if (existingMembership) {
    // Update their role to owner
    await db
      .update(serverMembers)
      .set({ role: 'owner' })
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, recipient.id)));
  } else {
    // Add them as owner
    await db.insert(serverMembers).values({
      serverId,
      userId: recipient.id,
      role: 'owner',
    });
  }

  // 3. Demote old owner to member
  await db
    .update(serverMembers)
    .set({ role: 'member' })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, currentOwnerId)));

  console.log(`[ServerService] Transferred ownership of server ${serverId} from ${currentOwnerId} to ${recipient.id} (${newOwnerEmail})`);
  return { success: true };
}

// ============================================================================
// Invite Links (Discord-style shareable links)
// ============================================================================

/**
 * Create a shareable invite link for a server
 */
export async function createInviteLink(
  serverId: string,
  createdById: string,
  options: { expiresIn?: number; maxUses?: number; skipPermissionCheck?: boolean }
): Promise<{ success: boolean; inviteLink?: any; error?: string }> {
  if (!options.skipPermissionCheck) {
    const hasPermission = await checkServerPermission(serverId, createdById, ['owner']);
    if (!hasPermission) {
      return { success: false, error: 'Only the server owner can create invite links' };
    }
  }

  const code = nanoid(10);
  const expiresAt = new Date(Date.now() + (options.expiresIn || 7 * 24 * 60 * 60) * 1000);

  const [link] = await db
    .insert(serverInviteLinks)
    .values({
      serverId,
      code,
      createdById,
      expiresAt,
      maxUses: options.maxUses || null,
    })
    .returning();

  return {
    success: true,
    inviteLink: {
      id: link.id,
      code: link.code,
      expiresAt: link.expiresAt.toISOString(),
      maxUses: link.maxUses,
      uses: link.uses,
      createdAt: link.createdAt.toISOString(),
    },
  };
}

/**
 * Get active invite links for a server
 */
export async function getInviteLinks(serverId: string): Promise<any[]> {
  const links = await db
    .select({
      id: serverInviteLinks.id,
      code: serverInviteLinks.code,
      expiresAt: serverInviteLinks.expiresAt,
      maxUses: serverInviteLinks.maxUses,
      uses: serverInviteLinks.uses,
      createdAt: serverInviteLinks.createdAt,
      createdByName: users.name,
    })
    .from(serverInviteLinks)
    .innerJoin(users, eq(serverInviteLinks.createdById, users.id))
    .where(
      and(
        eq(serverInviteLinks.serverId, serverId),
        gt(serverInviteLinks.expiresAt, new Date())
      )
    );

  // Filter out maxed-out links
  return links
    .filter((l) => !l.maxUses || l.uses < l.maxUses)
    .map((l) => ({
      id: l.id,
      code: l.code,
      expiresAt: l.expiresAt.toISOString(),
      maxUses: l.maxUses,
      uses: l.uses,
      createdBy: l.createdByName || 'Unknown',
      createdAt: l.createdAt.toISOString(),
    }));
}

/**
 * Revoke (delete) an invite link
 */
export async function revokeInviteLink(
  serverId: string,
  requesterId: string,
  linkId: string
): Promise<{ success: boolean; error?: string }> {
  const hasPermission = await checkServerPermission(serverId, requesterId, ['owner']);
  if (!hasPermission) {
    return { success: false, error: 'Only the server owner can revoke invite links' };
  }

  await db
    .delete(serverInviteLinks)
    .where(and(eq(serverInviteLinks.id, linkId), eq(serverInviteLinks.serverId, serverId)));

  return { success: true };
}

/**
 * Get public info about an invite link (no auth required)
 */
export async function getInviteLinkInfo(code: string): Promise<{ success: boolean; invite?: any; error?: string }> {
  const [link] = await db
    .select({
      code: serverInviteLinks.code,
      expiresAt: serverInviteLinks.expiresAt,
      maxUses: serverInviteLinks.maxUses,
      uses: serverInviteLinks.uses,
      serverName: servers.name,
      createdByName: users.name,
    })
    .from(serverInviteLinks)
    .innerJoin(servers, eq(serverInviteLinks.serverId, servers.id))
    .innerJoin(users, eq(serverInviteLinks.createdById, users.id))
    .where(eq(serverInviteLinks.code, code))
    .limit(1);

  if (!link) {
    return { success: false, error: 'Invite link not found' };
  }

  const now = new Date();
  const expired = link.expiresAt <= now;
  const maxedOut = link.maxUses ? link.uses >= link.maxUses : false;
  const valid = !expired && !maxedOut;

  return {
    success: true,
    invite: {
      code: link.code,
      serverName: link.serverName,
      creatorName: link.createdByName || 'Unknown',
      expiresAt: link.expiresAt.toISOString(),
      valid,
    },
  };
}

/**
 * Accept an invite link and join the server
 */
export async function acceptInviteLink(
  code: string,
  userId: string
): Promise<{ success: boolean; serverId?: string; error?: string }> {
  const [link] = await db
    .select({
      id: serverInviteLinks.id,
      serverId: serverInviteLinks.serverId,
      expiresAt: serverInviteLinks.expiresAt,
      maxUses: serverInviteLinks.maxUses,
      uses: serverInviteLinks.uses,
      createdById: serverInviteLinks.createdById,
    })
    .from(serverInviteLinks)
    .where(eq(serverInviteLinks.code, code))
    .limit(1);

  if (!link) {
    return { success: false, error: 'Invite link not found' };
  }

  const now = new Date();
  if (link.expiresAt <= now) {
    return { success: false, error: 'This invite link has expired' };
  }
  if (link.maxUses && link.uses >= link.maxUses) {
    return { success: false, error: 'This invite link has reached its maximum uses' };
  }

  // Check if banned
  if (await isUserBanned(link.serverId, userId)) {
    return { success: false, error: 'You are banned from this server' };
  }

  // Check if already a member
  const [existing] = await db
    .select({ id: serverMembers.id })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, link.serverId), eq(serverMembers.userId, userId)))
    .limit(1);

  if (existing) {
    return { success: true, serverId: link.serverId }; // Already a member, just return success
  }

  // Add as member
  await db.insert(serverMembers).values({
    serverId: link.serverId,
    userId,
    role: 'member',
    invitedById: link.createdById,
  });

  // Increment uses
  await db
    .update(serverInviteLinks)
    .set({ uses: sql`${serverInviteLinks.uses} + 1` })
    .where(eq(serverInviteLinks.id, link.id));

  return { success: true, serverId: link.serverId };
}

// ============================================================================
// Server Templates
// ============================================================================

/**
 * Build fetch headers for a RunHQ server request.
 * Generates a server session token and adds Fly routing headers if needed.
 */
async function buildServerFetchHeaders(
  server: Server,
  userId: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const token = await ServerSessionService.generateServerSessionToken(
    userId,
    server.id,
    300, // 5 min expiry
    { serverRole: 'owner' },
  );

  let url: string;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (server.machineId) {
    const provider = getProvider((server.provider || 'fly') as ProviderId);
    const routing = provider.getRoutingInfo(server.machineId, server.flyAppName);
    url = routing.serverUrl;
    if (routing.routingToken && routing.requiresRoutingHeaders) {
      headers['fly-force-instance-id'] = routing.routingToken;
    }
  } else {
    url = server.serverUrl!;
  }

  return { url, headers };
}

/**
 * Apply a template to a newly created server.
 * Waits for the new server to come online, fetches template data from the
 * source server, and imports it into the new server.
 */
export async function applyTemplate(
  newServerId: string,
  templateId: string,
  userId: string,
): Promise<void> {
  console.log(`[ServerService] Applying template ${templateId} to server ${newServerId}`);

  // 1. Look up template → get source serverId
  const [template] = await db
    .select()
    .from(serverTemplates)
    .where(eq(serverTemplates.id, templateId))
    .limit(1);
  if (!template) {
    console.error(`[ServerService] Template ${templateId} not found`);
    return;
  }

  // 2. Look up source server
  const sourceServer = await getServer(template.serverId);
  if (!sourceServer?.serverUrl) {
    console.error(`[ServerService] Template source server ${template.serverId} not found or has no URL`);
    return;
  }

  // 3. Wait for the new server to come online (poll every 5s, up to 5 minutes)
  let newServer: Server | null = null;
  for (let i = 0; i < 60; i++) {
    newServer = await getServer(newServerId);
    if (newServer?.status === 'online' && newServer?.serverUrl) {
      break;
    }
    if (newServer?.status === 'error') {
      console.error(`[ServerService] New server ${newServerId} entered error state, aborting template`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (!newServer?.serverUrl || newServer.status !== 'online') {
    console.error(`[ServerService] New server ${newServerId} did not come online in time`);
    return;
  }

  // 4. Fetch export from template server
  const { url: sourceUrl, headers: sourceHeaders } = await buildServerFetchHeaders(sourceServer, userId);
  console.log(`[ServerService] Fetching template export from ${sourceUrl}/api/export-template`);

  const exportRes = await fetch(`${sourceUrl}/api/export-template`, {
    headers: sourceHeaders,
  });

  if (!exportRes.ok) {
    console.error(`[ServerService] Failed to export template from ${template.serverId}: ${exportRes.status}`);
    return;
  }

  const exportData = await exportRes.json() as { success: boolean; data?: unknown };
  if (!exportData.success || !exportData.data) {
    console.error(`[ServerService] Template export returned error from ${template.serverId}`);
    return;
  }

  // 5. Post import to new server
  const { url: newUrl, headers: newHeaders } = await buildServerFetchHeaders(newServer, userId);
  console.log(`[ServerService] Importing template data to ${newUrl}/api/import-template`);

  const importRes = await fetch(`${newUrl}/api/import-template`, {
    method: 'POST',
    headers: newHeaders,
    body: JSON.stringify(exportData.data),
  });

  if (!importRes.ok) {
    console.error(`[ServerService] Failed to import template to ${newServerId}: ${importRes.status}`);
    return;
  }

  const importData = await importRes.json() as { success: boolean };
  if (!importData.success) {
    console.error(`[ServerService] Template import returned error for ${newServerId}`);
    return;
  }

  console.log(`[ServerService] Successfully applied template ${templateId} to server ${newServerId}`);
}
