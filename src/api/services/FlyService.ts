/**
 * Fly.io Service
 *
 * Handles Fly.io Machines API integration for remote server provisioning.
 * - Create machines for new remote servers
 * - Start/stop/suspend machines
 * - Delete machines when servers are deleted
 */

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import type { ServerTier } from '../../db/schema';
import { db } from '../../db/index';
import { systemSettings } from '../../db/schema';

// Fly.io Machines API base URL
const FLY_API_URL = 'https://api.machines.dev/v1';

// Read env vars at runtime via getters (not module load time, to ensure dotenv has loaded)
function getFlyAppName(): string {
  return process.env.FLY_APP_NAME || 'fishtank-workspaces';
}

// Server machines are created in a separate app from the API. When `override`
// is set (the per-tenant Fly app name from `servers.flyAppName`), it wins —
// this is how every Fly API call gets scoped to the right per-workspace app
// (see docs/per-app-isolation-migration.md). Legacy machines with NULL
// `flyAppName` fall through to the env-based shared-app default.
function getServerAppName(override?: string | null): string {
  if (override) return override;
  return process.env.SERVER_APP || getFlyAppName();
}

function getFlyApiToken(): string | undefined {
  return process.env.FLY_API_TOKEN;
}

function getFlyOrgSlug(): string | undefined {
  return process.env.FLY_ORG_SLUG;
}

/**
 * Per-workspace Fly app + network names. Each workspace lives in its own Fly
 * app on a dedicated 6PN network so peers cannot reach each other (see
 * docs/per-app-isolation-migration.md). Names are deterministic from the
 * server id so a workspace can be re-provisioned idempotently.
 */
export function workspaceAppName(serverId: string): string {
  // Fly app names: lowercase, alphanumeric + dashes, max 30 chars. Server ids
  // already match (e.g. ws_xxx). Replace `_` since Fly disallows underscores.
  return `ws-${serverId.replace(/_/g, '-').toLowerCase()}`;
}

export function workspaceNetworkName(serverId: string): string {
  return `${workspaceAppName(serverId)}-net`;
}

/**
 * Resolve the PREVIEW_DOMAIN env var that should be injected into a workspace
 * machine. Per-tenant workspaces always use the bare `tank.fish` zone — the
 * Cloudflare preview-router Worker (`*.tank.fish/*`) routes per-tenant staging
 * URLs by parsing a `-${flyAppName}-staging` suffix on the leftmost label
 * (added by the workspace's `getPreviewHostExtraSuffix()`), so a separate
 * `staging.tank.fish` zone is unnecessary. Legacy single-app workspaces keep
 * the existing `process.env.PREVIEW_DOMAIN` behaviour, which is `tank.fish`
 * in prod and `staging.tank.fish` in staging.
 */
function resolvePreviewDomainForWorkspace(appName?: string | null): string {
  if (appName) {
    return 'tank.fish';
  }
  return process.env.PREVIEW_DOMAIN ?? 'tank.fish';
}

type FlyAutostopMode = 'off' | 'stop' | 'suspend';
type FlyMachineLifecyclePolicy = {
  autostop: FlyAutostopMode;
  autostart: boolean;
  minMachinesRunning: number;
};

function getMachineLifecyclePolicy(autoSuspendEnabled: boolean): FlyMachineLifecyclePolicy {
  // When auto-suspend is enabled, the backend manages suspension timing via
  // heartbeat idle tracking + checkAutoSuspend() cron. Fly proxy autostop is
  // disabled so it doesn't race with our timeout. autostart remains true so
  // Fly proxy still wakes stopped/suspended machines on incoming requests.
  if (autoSuspendEnabled) {
    return {
      autostop: 'off',
      autostart: true,
      minMachinesRunning: 0,
    };
  }

  return {
    autostop: 'off',
    autostart: true,
    minMachinesRunning: 1,
  };
}

function getServerMachineAutostop(): FlyAutostopMode {
  const rawMode = process.env.SERVER_MACHINE_AUTOSTOP?.trim().toLowerCase();
  if (!rawMode) return 'suspend';

  if (rawMode === 'off' || rawMode === 'stop' || rawMode === 'suspend') {
    return rawMode;
  }

  console.warn(
    `[FlyService] Invalid SERVER_MACHINE_AUTOSTOP="${rawMode}". Falling back to "suspend".`
  );
  return 'suspend';
}

function getServerMachineAutostart(): boolean {
  const rawValue = process.env.SERVER_MACHINE_AUTOSTART?.trim().toLowerCase();
  if (!rawValue) return true;

  if (rawValue === '0' || rawValue === 'false' || rawValue === 'no') {
    return false;
  }

  if (rawValue === '1' || rawValue === 'true' || rawValue === 'yes') {
    return true;
  }

  console.warn(
    `[FlyService] Invalid SERVER_MACHINE_AUTOSTART="${rawValue}". Falling back to true.`
  );
  return true;
}

function getServerMinMachinesRunning(): number {
  const rawValue = process.env.SERVER_MIN_MACHINES_RUNNING?.trim();
  if (!rawValue) return 0;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[FlyService] Invalid SERVER_MIN_MACHINES_RUNNING="${rawValue}". Falling back to 0.`
    );
    return 0;
  }

  return parsed;
}

function getDefaultLifecyclePolicy(): FlyMachineLifecyclePolicy {
  return {
    autostop: getServerMachineAutostop(),
    autostart: getServerMachineAutostart(),
    minMachinesRunning: getServerMinMachinesRunning(),
  };
}

// ============================================================================
// Types
// ============================================================================

export type FlyMachineState =
  | 'created'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'replacing'
  | 'destroying'
  | 'destroyed'
  | 'suspended';

export interface FlyMachineCheck {
  name: string;
  status: 'passing' | 'warning' | 'critical' | 'unknown';
  output?: string;
  updated_at?: string;
}

export interface FlyMachine {
  id: string;
  name: string;
  state: FlyMachineState;
  region: string;
  instance_id: string;
  private_ip: string;
  created_at: string;
  updated_at: string;
  checks?: FlyMachineCheck[];
  config: {
    image: string;
    env: Record<string, string>;
    guest: {
      cpu_kind: string;
      cpus: number;
      memory_mb: number;
    };
    services: FlyMachineService[];
    mounts?: Array<{
      volume: string;
      path: string;
    }>;
  };
}

export interface FlyMachineService {
  ports: Array<{ port: number; handlers: string[] }>;
  protocol: string;
  internal_port: number;
  autostop?: FlyAutostopMode;
  autostart?: boolean;
  min_machines_running?: number;
  concurrency?: {
    type: string;
    hard_limit: number;
    soft_limit: number;
  };
}

export interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
  encrypted: boolean;
  created_at: string;
}

// Machine specs per server tier
const TIER_CONFIGS: Partial<Record<ServerTier, { cpu_kind: string; cpus: number; memory_mb: number; volume_gb: number }>> = {
  // New tiers: shared CPU — volume_gb must match client tiers.ts storage values
  'shared-4x-1gb':   { cpu_kind: 'shared',      cpus: 4, memory_mb: 1024,  volume_gb: 12 },
  'shared-4x-2gb':   { cpu_kind: 'shared',      cpus: 4, memory_mb: 2048,  volume_gb: 20 },
  'shared-4x-4gb':   { cpu_kind: 'shared',      cpus: 4, memory_mb: 4096,  volume_gb: 40 },
  'shared-4x-8gb':   { cpu_kind: 'shared',      cpus: 4, memory_mb: 8192,  volume_gb: 40 },
  'shared-8x-4gb':   { cpu_kind: 'shared',      cpus: 8, memory_mb: 4096,  volume_gb: 40 },
  'shared-8x-8gb':   { cpu_kind: 'shared',      cpus: 8, memory_mb: 8192,  volume_gb: 60 },
  'shared-8x-16gb':  { cpu_kind: 'shared',      cpus: 8, memory_mb: 16384, volume_gb: 80 },
  // New tiers: performance CPU
  'perf-2x-4gb':     { cpu_kind: 'performance', cpus: 2, memory_mb: 4096,  volume_gb: 40 },
  'perf-2x-8gb':     { cpu_kind: 'performance', cpus: 2, memory_mb: 8192,  volume_gb: 60 },
  'perf-2x-16gb':    { cpu_kind: 'performance', cpus: 2, memory_mb: 16384, volume_gb: 80 },
  'perf-4x-8gb':     { cpu_kind: 'performance', cpus: 4, memory_mb: 8192,  volume_gb: 60 },
  'perf-4x-16gb':    { cpu_kind: 'performance', cpus: 4, memory_mb: 16384, volume_gb: 100 },
  'perf-4x-32gb':    { cpu_kind: 'performance', cpus: 4, memory_mb: 32768, volume_gb: 160 },
  // Legacy tiers (kept for existing machines)
  'shared-cpu-1x':       { cpu_kind: 'shared',      cpus: 1, memory_mb: 2048,  volume_gb: 1 },
  'shared-cpu-2x':       { cpu_kind: 'shared',      cpus: 2, memory_mb: 4096,  volume_gb: 5 },
  'shared-cpu-4x':       { cpu_kind: 'shared',      cpus: 4, memory_mb: 4096,  volume_gb: 10 },
  'performance-cpu-2x':  { cpu_kind: 'performance', cpus: 2, memory_mb: 4096,  volume_gb: 10 },
  'performance-cpu-4x':  { cpu_kind: 'performance', cpus: 4, memory_mb: 8192,  volume_gb: 20 },
  'xlarge':              { cpu_kind: 'shared',      cpus: 4, memory_mb: 16384, volume_gb: 30 },
  'xxlarge':             { cpu_kind: 'shared',      cpus: 8, memory_mb: 32768, volume_gb: 50 },
};

export interface CreateMachineOptions {
  serverId: string;
  serverToken: string;
  tunnelToken?: string | null;
  region?: string;
  name?: string;
  tier?: ServerTier;
  existingVolumeId?: string | null;
  autoSuspendEnabled?: boolean;
  // Per-tenant Fly app name (from `servers.flyAppName`). When provided, the
  // machine + volume are created in this app instead of the legacy shared one.
  // Caller is responsible for having created the app first via createApp().
  appName?: string | null;
}

export interface CreateMachineResult {
  machineId: string;
  machineName: string;
  url: string;
  region: string;
  volumeId: string;
}

// ============================================================================
// API Helpers
// ============================================================================

// IP allocation, certs, and a few other resources still live on Fly's older
// GraphQL endpoint rather than the Machines REST API.
const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';

async function flyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = getFlyApiToken();
  if (!token) {
    throw new Error('FLY_API_TOKEN is not configured');
  }

  const response = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fly.io GraphQL API error: ${response.status} - ${errorText}`);
  }

  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Fly.io GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  }
  return json.data as T;
}

async function flyRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = getFlyApiToken();
  if (!token) {
    throw new Error('FLY_API_TOKEN is not configured');
  }

  const url = `${FLY_API_URL}${path}`;
  console.log(`[FlyService] ${method} ${url}`);

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000), // 30s timeout per API call
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[FlyService] API error: ${response.status} - ${errorText}`);
    throw new Error(`Fly.io API error: ${response.status} - ${errorText}`);
  }

  // Some endpoints return empty body (204 No Content)
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

// ============================================================================
// Image Resolution
// ============================================================================

/**
 * Get the latest server image from the DB (set by deploy script via set-server-version).
 * Falls back to registry.fly.io/APP:latest if no image ref is stored.
 */
async function getLatestReleaseImage(): Promise<string> {
  try {
    const [row] = await db.select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'latest_server_image'));
    if (row?.value) {
      console.log(`[FlyService] Using image from DB: ${row.value}`);
      return row.value;
    }
  } catch (err) {
    console.error('[FlyService] Failed to read latest_server_image from DB:', err);
  }
  // Fallback (should not happen after first deploy with imageRef)
  const appName = getServerAppName();
  const fallback = `registry.fly.io/${appName}:latest`;
  console.log(`[FlyService] WARNING: No image in DB, falling back to ${fallback}`);
  return fallback;
}

// ============================================================================
// App Management
// ============================================================================

/**
 * Create a Fly app on its own dedicated 6PN network. The network is created
 * implicitly by passing `network` in the request body; if a network with that
 * name already exists in the org it is reused (Fly's idempotent semantics).
 *
 * Used to provision a per-workspace app so tenant machines cannot reach each
 * other on Fly's private IPv6 mesh. See docs/per-app-isolation-migration.md.
 *
 * Idempotent: if the app already exists, returns without error.
 */
export async function createApp(appName: string, networkName: string): Promise<void> {
  const orgSlug = getFlyOrgSlug();
  if (!orgSlug) {
    throw new Error('FLY_ORG_SLUG is not configured');
  }

  try {
    await flyRequest<{ id: string }>('POST', '/apps', {
      app_name: appName,
      org_slug: orgSlug,
      network: networkName,
    });
  } catch (err) {
    // Fly returns 422 with body containing "already taken" / "name has already
    // been taken" if the app exists. Treat as success so the caller can retry
    // provisioning safely.
    const message = err instanceof Error ? err.message : String(err);
    if (/422/.test(message) && /taken/i.test(message)) {
      console.log(`[FlyService] App ${appName} already exists; reusing`);
      return;
    }
    throw err;
  }
}

/**
 * Allocate public IP addresses for an app so it's reachable on its
 * `<app>.fly.dev` anycast. Defaults to one shared IPv4 (free) + one
 * dedicated IPv6 (free).
 *
 * Per-tenant apps need this in addition to a machine: without IPs, Fly's
 * edge has nowhere to route public traffic for `<app>.fly.dev`. Legacy apps
 * have IPs allocated at app-create time; new apps via `POST /v1/apps` do
 * NOT auto-allocate, so we do it explicitly here.
 *
 * Idempotent — Fly returns "already allocated" which we treat as success.
 */
export async function allocateIPs(
  appName: string,
  opts?: { sharedV4?: boolean; v6?: boolean },
): Promise<void> {
  const wantsV6 = opts?.v6 ?? true;
  const wantsSharedV4 = opts?.sharedV4 ?? true;

  const allocate = async (type: 'v6' | 'shared_v4') => {
    try {
      await flyGraphQL(
        `mutation Allocate($input: AllocateIPAddressInput!) {
          allocateIpAddress(input: $input) {
            ipAddress { id type address }
          }
        }`,
        { input: { appId: appName, type } },
      );
      console.log(`[FlyService] Allocated ${type} IP for app ${appName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already|exist/i.test(message)) {
        console.log(`[FlyService] ${type} IP already allocated for ${appName}`);
        return;
      }
      throw err;
    }
  };

  if (wantsSharedV4) await allocate('shared_v4');
  if (wantsV6) await allocate('v6');
}

/**
 * Issue a TLS certificate for `hostname` on a Fly app. Uses Fly's GraphQL
 * `addCertificate` mutation (the same path `flyctl certs add` uses);
 * Fly's REST endpoint for cert creation is documented as
 * `/apps/{app}/certificates/acme`, but the GraphQL mutation works
 * uniformly across cert states and is what the official CLI exercises.
 *
 * Validation: Fly attempts ACME automatically. With CF in front of the
 * subdomain (proxied: true), Cloudflare may break the HTTP-01 path; in
 * that case the cert sits in "Not verified" state and the operator can
 * fall back to the `_fly-ownership` TXT record validation that
 * `flyctl certs setup` documents. Critically, an unverified cert does NOT
 * block user traffic in our setup: CF presents its own edge cert
 * (universal SSL or wildcard) to browsers, and Fly's origin connection
 * uses the standing `*.fly.dev` cert.
 *
 * This function therefore treats failures as warnings — best-effort. The
 * provisioning flow will not fail because of a cert hiccup.
 *
 * Idempotent on "hostname has already been taken".
 */
export async function addCertificate(appName: string, hostname: string): Promise<void> {
  try {
    // Fly's addCertificate mutation takes appId + hostname as direct args,
    // NOT through an input wrapper (verified against flyctl source). The
    // appId field accepts the app slug (e.g. "ws-ws-foo"), not the GraphQL
    // node ID.
    await flyGraphQL<{ addCertificate: { certificate: { id: string; hostname: string } } }>(
      `mutation Add($appId: ID!, $hostname: String!) {
        addCertificate(appId: $appId, hostname: $hostname) {
          certificate { id hostname }
        }
      }`,
      { appId: appName, hostname },
    );
    console.log(`[FlyService] Added cert for ${hostname} on ${appName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/(taken|already|exist|duplicate)/i.test(message)) {
      console.log(`[FlyService] Cert for ${hostname} on ${appName} already exists`);
      return;
    }
    // Anything else is a soft failure — log and continue. CF's edge cert
    // covers user-facing TLS regardless of Fly cert state.
    console.warn(`[FlyService] addCertificate(${hostname}, ${appName}) failed (best-effort, not blocking):`, message);
  }
}

/**
 * Delete a Fly app and all its machines/volumes/networks. Must be called only
 * after the app's machine and volume have been removed (or with the
 * understanding that this cascades).
 *
 * Idempotent: a 404 (app already gone) is treated as success.
 */
export async function deleteApp(appName: string): Promise<void> {
  try {
    await flyRequest<unknown>('DELETE', `/apps/${appName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/404/.test(message)) {
      console.log(`[FlyService] App ${appName} already deleted`);
      return;
    }
    throw err;
  }
}

// ============================================================================
// Volume Management
// ============================================================================

/**
 * List all volumes for the app
 */
export async function listVolumes(appName?: string | null): Promise<FlyVolume[]> {
  return flyRequest<FlyVolume[]>('GET', `/apps/${getServerAppName(appName)}/volumes`);
}

/**
 * Create a volume for persistent storage
 */
export async function createVolume(
  name: string,
  region: string,
  sizeGb: number = 1,
  appName?: string | null,
): Promise<FlyVolume> {
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName(appName)}/volumes`, {
    name,
    region,
    size_gb: sizeGb,
    encrypted: true,
  });
}

/**
 * Get a volume by ID
 */
export async function getVolume(volumeId: string, appName?: string | null): Promise<FlyVolume | null> {
  try {
    return await flyRequest<FlyVolume>('GET', `/apps/${getServerAppName(appName)}/volumes/${volumeId}`);
  } catch {
    return null;
  }
}

/**
 * Fork a volume to a new region (cross-region clone).
 * Uses Fly.io's source_volume_id feature for block-level copying.
 * The forked volume is immediately usable — data hydrates lazily in the background.
 */
export async function forkVolume(
  sourceVolumeId: string,
  name: string,
  region: string,
  sizeGb: number = 1,
  appName?: string | null,
): Promise<FlyVolume> {
  console.log(`[FlyService] Forking volume ${sourceVolumeId} to region ${region} (${sizeGb}GB)`);
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName(appName)}/volumes`, {
    name,
    region,
    size_gb: sizeGb,
    encrypted: true,
    source_volume_id: sourceVolumeId,
  });
}

/**
 * Extend a volume to a larger size (cannot shrink)
 */
export async function extendVolume(volumeId: string, newSizeGb: number, appName?: string | null): Promise<void> {
  await flyRequest<unknown>('PUT', `/apps/${getServerAppName(appName)}/volumes/${volumeId}/extend`, {
    size_gb: newSizeGb,
  });
  console.log(`[FlyService] Extended volume ${volumeId} to ${newSizeGb}GB`);
}

/**
 * Create a volume from a snapshot (used for downsizing volumes and for
 * cross-app migration of an existing workspace into its own per-tenant Fly app).
 */
export async function createVolumeFromSnapshot(
  snapshotId: string,
  name: string,
  region: string,
  sizeGb: number,
  appName?: string | null,
): Promise<FlyVolume> {
  console.log(`[FlyService] Creating volume from snapshot ${snapshotId} in ${region} (${sizeGb}GB)`);
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName(appName)}/volumes`, {
    name,
    region,
    size_gb: sizeGb,
    encrypted: true,
    snapshot_id: snapshotId,
  });
}

/**
 * Delete a volume
 */
export async function deleteVolume(volumeId: string, appName?: string | null): Promise<void> {
  await flyRequest<void>('DELETE', `/apps/${getServerAppName(appName)}/volumes/${volumeId}`);
  console.log(`[FlyService] Deleted volume ${volumeId}`);
}

/**
 * Create an on-demand snapshot of a volume and wait for it to be ready.
 * Fly.io snapshot creation is async — the API returns a graph_id immediately
 * but the snapshot isn't usable until it appears in the snapshots list.
 */
export async function createSnapshot(volumeId: string, appName?: string | null): Promise<{ id: string }> {
  const result = await flyRequest<{ Msg: { backup: { graph_id: string } } }>(
    'POST',
    `/apps/${getServerAppName(appName)}/volumes/${volumeId}/snapshots`
  );
  const snapshotId = result.Msg?.backup?.graph_id || 'unknown';
  console.log(`[FlyService] Created snapshot ${snapshotId} for volume ${volumeId}, waiting for it to be ready...`);

  // Poll until the snapshot appears in the list (ready to use)
  const maxWaitMs = 300_000; // 5 minutes
  const pollIntervalMs = 3_000; // 3 seconds
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const snapshots = await listSnapshots(volumeId, appName);
      const snap = snapshots.find(s => s.id === snapshotId);
      if (snap) {
        if (snap.status === 'created') {
          console.log(`[FlyService] Snapshot ${snapshotId} is ready (waited ${Math.round((Date.now() - start) / 1000)}s)`);
          return { id: snapshotId };
        }
        console.log(`[FlyService] Snapshot ${snapshotId} found but status is '${snap.status}', waiting...`);
      }
    } catch {
      // List call failed, keep polling
    }
  }

  // Timed out but still return the ID — createVolumeFromSnapshot will fail with a clear error if it's not ready
  console.warn(`[FlyService] Snapshot ${snapshotId} not confirmed ready after ${maxWaitMs / 1000}s, proceeding anyway`);
  return { id: snapshotId };
}

/**
 * List snapshots for a volume
 */
export async function listSnapshots(volumeId: string, appName?: string | null): Promise<Array<{ id: string; size: number; created_at: string; status?: string }>> {
  return flyRequest<Array<{ id: string; size: number; created_at: string; status?: string }>>(
    'GET',
    `/apps/${getServerAppName(appName)}/volumes/${volumeId}/snapshots`
  );
}

/**
 * Get or create a volume for a server.
 * Uses the DB-stored volumeId if available, otherwise creates a new one.
 * Never searches by name — that leads to adopting ghost/deleted volumes.
 */
async function getOrCreateVolume(
  serverId: string,
  region: string,
  sizeGb: number = 1,
  existingVolumeId?: string | null,
  appName?: string | null,
): Promise<string> {
  if (existingVolumeId) {
    try {
      const vol = await getVolume(existingVolumeId, appName);
      if (vol && vol.state === 'created' && vol.region === region) {
        console.log(`[FlyService] Reusing existing volume ${existingVolumeId} for server ${serverId}`);
        return existingVolumeId;
      }
      if (vol && vol.state !== 'created') {
        console.warn(`[FlyService] Volume ${existingVolumeId} is in state '${vol.state}', creating new volume`);
      } else if (vol) {
        console.warn(`[FlyService] Volume ${existingVolumeId} is in region ${vol.region} but need ${region}, creating new volume`);
      }
    } catch {
      console.warn(`[FlyService] Volume ${existingVolumeId} not found, creating new volume`);
    }
  }

  const sanitizedId = serverId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  const volumeName = `data_${sanitizedId}`;
  const volume = await createVolume(volumeName, region, sizeGb, appName);
  console.log(`[FlyService] Created volume ${volume.id} for server ${serverId}`);
  return volume.id;
}

// ============================================================================
// Machine Management
// ============================================================================

/**
 * List all machines in the app
 */
export async function listMachines(appName?: string | null): Promise<FlyMachine[]> {
  return flyRequest<FlyMachine[]>('GET', `/apps/${getServerAppName(appName)}/machines`);
}


/**
 * Get a machine by ID
 */
export async function getMachine(machineId: string, appName?: string | null): Promise<FlyMachine> {
  return flyRequest<FlyMachine>(
    'GET',
    `/apps/${getServerAppName(appName)}/machines/${machineId}`
  );
}

/**
 * Update a machine's auto-suspend policy in-place.
 * Applies immediately via Fly Machines API.
 */
export async function updateMachineAutoSuspend(
  machineId: string,
  autoSuspendEnabled: boolean,
  appName?: string | null,
): Promise<FlyMachine> {
  const machine = await getMachine(machineId, appName);
  if (machine.state === 'destroyed' || machine.state === 'destroying') {
    throw new Error(`Cannot update lifecycle policy for destroyed machine ${machineId}`);
  }

  const { autostop, autostart, minMachinesRunning } = getMachineLifecyclePolicy(autoSuspendEnabled);

  const updatedServices: FlyMachineService[] = (machine.config.services || []).map((service) => ({
    ...service,
    autostop,
    autostart,
    min_machines_running: minMachinesRunning,
  }));

  const payload = {
    name: machine.name,
    config: {
      ...machine.config,
      services: updatedServices,
    },
  };

  console.log(
    `[FlyService] Updating machine ${machineId} lifecycle policy autostop=${autostop}, autostart=${autostart}, min_machines_running=${minMachinesRunning}`
  );

  return flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}`,
    payload
  );
}

/**
 * Ensure a machine has the specified tunnel token in its environment.
 * No-op when the token already matches.
 */
export async function ensureMachineTunnelToken(
  machineId: string,
  tunnelToken: string,
  appName?: string | null,
): Promise<FlyMachine> {
  const machine = await getMachine(machineId, appName);
  if (machine.state === 'destroyed' || machine.state === 'destroying') {
    throw new Error(`Cannot update env for destroyed machine ${machineId}`);
  }

  const currentToken = machine.config?.env?.TUNNEL_TOKEN;
  if (currentToken === tunnelToken) {
    return machine;
  }

  console.log(`[FlyService] Updating machine ${machineId} tunnel token`);

  return flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}`,
    {
      name: machine.name,
      config: {
        ...machine.config,
        env: {
          ...(machine.config?.env || {}),
          TUNNEL_TOKEN: tunnelToken,
        },
      },
    }
  );
}

/**
 * Create a new machine for a remote server
 */
export async function createMachine(
  options: CreateMachineOptions
): Promise<CreateMachineResult> {
  const { serverId, serverToken, tunnelToken, region = 'iad', name, tier = 'shared-cpu-1x', existingVolumeId, autoSuspendEnabled, appName } = options;
  const tierConfig = TIER_CONFIGS[tier] || TIER_CONFIGS['shared-cpu-1x']!;
  const lifecyclePolicy = typeof autoSuspendEnabled === 'boolean'
    ? getMachineLifecyclePolicy(autoSuspendEnabled)
    : getDefaultLifecyclePolicy();
  const { autostop, autostart, minMachinesRunning } = lifecyclePolicy;

  // Generate machine name
  const shortId = serverId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const machineName = name || `srv-${shortId}-${nanoid(6)}`;

  console.log(`[FlyService] Creating machine ${machineName} in region ${region} (tier: ${tier}, ${tierConfig.cpu_kind} ${tierConfig.cpus}vCPU/${tierConfig.memory_mb}MB/${tierConfig.volume_gb}GB)`);
  console.log(
    `[FlyService] Machine lifecycle policy autostop=${autostop}, autostart=${autostart}, min_machines_running=${minMachinesRunning}`
  );

  // Workspaces now fail-fast without a public key in cloud mode, so we
  // refuse to create a machine that would boot-loop. Also guards against
  // silently shipping an empty string env var to Fly.
  const sessionPublicKeyPem = process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
  if (!sessionPublicKeyPem) {
    throw new Error(
      'SERVER_SESSION_PUBLIC_KEY_PEM is not set on the backend. Refusing to create a workspace machine that cannot verify session tokens.',
    );
  }

  // Get the latest release image and volume in parallel
  const [latestImage, volumeId] = await Promise.all([
    getLatestReleaseImage(),
    getOrCreateVolume(serverId, region, tierConfig.volume_gb, existingVolumeId, appName),
  ]);

  // Build machine config
  const machineConfig: Record<string, unknown> = {
    name: machineName,
    region,
    config: {
      image: latestImage,
      env: {
        SERVER_TOKEN: serverToken,
        ...(tunnelToken ? { TUNNEL_TOKEN: tunnelToken } : {}),
        SERVER_ID: serverId,
        SERVER_NAME: machineName,
        AUTH_MODE: 'cloud',
        CLOUD_API_URL: process.env.CLOUD_API_URL || 'https://console.runhq.io',
        SERVER_SESSION_PUBLIC_KEY_PEM: sessionPublicKeyPem,
        PREVIEW_DOMAIN: resolvePreviewDomainForWorkspace(appName),
        CLIENT_URL: process.env.CLIENT_URL ?? 'https://app.runhq.io',
        NODE_ENV: 'development',
        PORT: '61987',
        HOST: '0.0.0.0',
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ['tls', 'http'] },
            { port: 80, handlers: ['http'] },
          ],
          protocol: 'tcp',
          internal_port: 61987,
          autostop,
          autostart,
          min_machines_running: minMachinesRunning,
          concurrency: {
            type: 'connections',
            hard_limit: 100,
            soft_limit: 80,
          },
        },
      ],
      guest: {
        cpu_kind: tierConfig.cpu_kind,
        cpus: tierConfig.cpus,
        memory_mb: tierConfig.memory_mb,
      },
      checks: {
        httpget: {
          type: 'http',
          port: 61987,
          path: '/health',
          interval: '30s',
          timeout: '5s',
          grace_period: '30s',
        },
      },
    },
  };

  // Add volume mount for persistent storage
  (machineConfig.config as Record<string, unknown>).mounts = [
    {
      volume: volumeId,
      path: '/app/data',
    },
  ];

  const machine = await flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines`,
    machineConfig
  );

  // Construct the public URL (app-level URL, use Fly-Force-Instance-Id header for per-machine routing)
  const url = `https://${getServerAppName(appName)}.fly.dev`;

  console.log(`[FlyService] Created machine ${machine.id} (${machineName}) at ${url}`);

  return {
    machineId: machine.id,
    machineName,
    url,
    region,
    volumeId,
  };
}

/**
 * Update a machine's config in-place.
 * Fetches the current machine, applies a config modifier function, and POSTs the update.
 */
export async function updateMachineConfig(
  machineId: string,
  configModifier: (config: Record<string, unknown>) => Record<string, unknown>,
  options?: { skipLaunch?: boolean; appName?: string | null },
): Promise<FlyMachine> {
  const machine = await getMachine(machineId, options?.appName);
  const updatedConfig = configModifier({ ...machine.config } as unknown as Record<string, unknown>);

  const queryParams = options?.skipLaunch ? '?skip_launch=true' : '';
  return flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName(options?.appName)}/machines/${machineId}${queryParams}`,
    { config: updatedConfig },
  );
}

/**
 * Start a stopped/suspended machine
 * Handles 409/412 errors if machine is already starting or active
 */
export async function startMachine(machineId: string, appName?: string | null): Promise<void> {
  console.log(`[FlyService] Starting machine ${machineId}`);
  try {
    await flyRequest<void>(
      'POST',
      `/apps/${getServerAppName(appName)}/machines/${machineId}/start`
    );
  } catch (error) {
    if (error instanceof Error) {
      // 409 means machine is already starting - that's fine
      if (error.message.includes('409')) {
        console.log(`[FlyService] Machine ${machineId} is already starting`);
        return;
      }
      // 412 means machine is already active/running - that's also fine
      if (error.message.includes('412')) {
        console.log(`[FlyService] Machine ${machineId} is already active`);
        return;
      }
    }
    throw error;
  }
}

/**
 * Stop a running machine
 */
export async function stopMachine(machineId: string, appName?: string | null): Promise<void> {
  console.log(`[FlyService] Stopping machine ${machineId}`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}/stop`
  );
}

/**
 * Suspend a machine (faster restart than stop)
 */
export async function suspendMachine(machineId: string, appName?: string | null): Promise<void> {
  console.log(`[FlyService] Suspending machine ${machineId}`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}/suspend`
  );
}

/**
 * Restart a running machine in-place (preserves ephemeral filesystem).
 * Uses Fly.io's native restart endpoint which restarts the process
 * without rebuilding the container, so globally installed packages survive.
 */
export async function restartMachine(machineId: string, appName?: string | null): Promise<void> {
  console.log(`[FlyService] Restarting machine ${machineId} (in-place)`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}/restart`
  );
}

/**
 * Update a machine to the latest release image and restart it.
 * Fetches the current machine config, swaps the image to the latest release,
 * and issues an update via the Machines API (which also restarts the machine).
 */
export async function updateMachineImage(machineId: string, appName?: string | null): Promise<void> {
  const [machine, latestImage] = await Promise.all([
    getMachine(machineId, appName),
    getLatestReleaseImage(),
  ]);

  // Always use machine update (not restart) to force an image pull,
  // even when the tag is the same — the underlying image may have changed.
  console.log(`[FlyService] Updating machine ${machineId} image: ${machine.config.image} → ${latestImage}`);

  // Fail before the Fly API call if the session public key is missing. If we
  // passed `|| ''` we would overwrite a valid existing public key with an
  // empty string and brick the machine on next restart.
  const sessionPublicKeyPem = process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
  if (!sessionPublicKeyPem) {
    throw new Error(
      'SERVER_SESSION_PUBLIC_KEY_PEM is not set on the backend. Refusing to update machine env with an empty public key.',
    );
  }

  // Fly's machine update API replaces the full `env` map, so omitting a key
  // here removes it from the machine. We deliberately drop the legacy shared
  // HMAC secret (`SERVER_SESSION_SECRET`) from every existing machine so the
  // forgery material is physically gone, not just unused by the new code.
  const rawExistingEnv = (machine.config.env as Record<string, string>) || {};
  const { SERVER_SESSION_SECRET: _stripped, ...existingEnv } = rawExistingEnv;
  void _stripped;

  await flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName(appName)}/machines/${machineId}`,
    {
      config: {
        ...machine.config,
        image: latestImage,
        env: {
          ...existingEnv,
          PREVIEW_DOMAIN: resolvePreviewDomainForWorkspace(appName),
          CLOUD_API_URL: process.env.CLOUD_API_URL || 'https://console.runhq.io',
          CLIENT_URL: process.env.CLIENT_URL ?? 'https://app.runhq.io',
          SERVER_SESSION_PUBLIC_KEY_PEM: sessionPublicKeyPem,
        },
      },
    }
  );
}

/**
 * Delete a machine
 */
export async function deleteMachine(machineId: string, appName?: string | null): Promise<void> {
  console.log(`[FlyService] Deleting machine ${machineId}`);
  await flyRequest<void>(
    'DELETE',
    `/apps/${getServerAppName(appName)}/machines/${machineId}?force=true`
  );
}

/**
 * Wait for a machine to reach a specific state
 */
export async function waitForMachine(
  machineId: string,
  targetStates: FlyMachineState[] = ['started'],
  timeoutMs: number = 90000,
  appName?: string | null,
): Promise<FlyMachine> {
  const start = Date.now();
  const pollInterval = 500;

  console.log(`[FlyService] Waiting for machine ${machineId} to reach state: ${targetStates.join(' or ')}`);

  while (Date.now() - start < timeoutMs) {
    const machine = await getMachine(machineId, appName);

    if (targetStates.includes(machine.state)) {
      console.log(`[FlyService] Machine ${machineId} reached state: ${machine.state}`);
      return machine;
    }

    // Check for terminal failure states
    if (machine.state === 'destroyed' || machine.state === 'destroying') {
      throw new Error(`Machine ${machineId} was destroyed`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for machine ${machineId} to reach state: ${targetStates.join(' or ')}`
  );
}

/**
 * Wait for a machine to be healthy by directly polling its health endpoint
 * This is critical for ensuring Fly.io routes traffic to this machine
 */
export async function waitForMachineHealthy(
  machineId: string,
  timeoutMs: number = 60000,
  appName?: string | null,
): Promise<FlyMachine> {
  const start = Date.now();
  const pollInterval = 1000; // Poll every second

  console.log(`[FlyService] Waiting for machine ${machineId} to be healthy`);

  // Directly poll the machine's health endpoint through Fly.io routing
  const healthUrl = `https://${getServerAppName(appName)}.fly.dev/health?fly_instance_id=${machineId}`;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          // Force routing to specific machine
          'Fly-Force-Instance-Id': machineId,
        },
        signal: AbortSignal.timeout(10000), // 10s timeout per health check
      });

      if (response.ok) {
        console.log(`[FlyService] Machine ${machineId} is healthy (status ${response.status})`);
        return await getMachine(machineId, appName);
      }

      console.log(`[FlyService] Machine ${machineId} health check returned ${response.status}`);
    } catch (error) {
      // Connection refused, timeout, etc. - machine not ready yet
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[FlyService] Machine ${machineId} health check failed: ${msg}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout - return the machine anyway so creation can complete
  console.warn(`[FlyService] Timeout waiting for machine ${machineId} to be healthy after ${timeoutMs}ms`);
  return await getMachine(machineId, appName);
}

/**
 * Check if Fly.io is configured and available
 */
export function isConfigured(): boolean {
  const token = getFlyApiToken();
  const appName = getFlyAppName();
  const configured = !!token && !!appName;
  if (!configured) {
    console.log(`[FlyService] isConfigured: ${configured} (token=${!!token}, appName=${appName})`);
  }
  return configured;
}

/**
 * Get the Fly.io app name (API app)
 */
export function getAppName(): string {
  return getFlyAppName();
}

/**
 * Get the server app name (where server machines run)
 */
export function getServerAppNamePublic(): string {
  return getServerAppName();
}
