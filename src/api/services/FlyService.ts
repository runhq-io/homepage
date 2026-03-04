/**
 * Fly.io Service
 *
 * Handles Fly.io Machines API integration for remote server provisioning.
 * - Create machines for new remote servers
 * - Start/stop/suspend machines
 * - Delete machines when servers are deleted
 */

import { nanoid } from 'nanoid';
import type { ServerTier } from '../../db/schema';

// Fly.io Machines API base URL
const FLY_API_URL = 'https://api.machines.dev/v1';

// Fly.io Platform GraphQL API
const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql';

// Read env vars at runtime via getters (not module load time, to ensure dotenv has loaded)
function getFlyAppName(): string {
  return process.env.FLY_APP_NAME || 'fishtank-workspaces';
}

// Server machines are created in a separate app from the API
function getServerAppName(): string {
  return process.env.SERVER_APP || getFlyAppName();
}

function getFlyApiToken(): string | undefined {
  return process.env.FLY_API_TOKEN;
}

type FlyAutostopMode = 'off' | 'stop' | 'suspend';
type FlyMachineLifecyclePolicy = {
  autostop: FlyAutostopMode;
  autostart: boolean;
  minMachinesRunning: number;
};

function getMachineLifecyclePolicy(autoSuspendEnabled: boolean): FlyMachineLifecyclePolicy {
  if (autoSuspendEnabled) {
    return {
      autostop: 'suspend',
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
  'shared-cpu-1x':       { cpu_kind: 'shared',      cpus: 1, memory_mb: 2048,  volume_gb: 1 },
  'shared-cpu-2x':       { cpu_kind: 'shared',      cpus: 2, memory_mb: 4096,  volume_gb: 5 },
  'shared-cpu-4x':       { cpu_kind: 'shared',      cpus: 4, memory_mb: 4096,  volume_gb: 10 },
  'performance-cpu-2x':  { cpu_kind: 'performance', cpus: 2, memory_mb: 4096,  volume_gb: 10 },
  'performance-cpu-4x':  { cpu_kind: 'performance', cpus: 4, memory_mb: 8192,  volume_gb: 20 },
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
 * Get the latest release image from the Fly.io GraphQL API.
 * Uses `currentRelease.imageRef` which points to the newest release,
 * regardless of whether it deployed machines (unlike the `:latest` tag
 * which only resolves to the last "running" release).
 */
async function getLatestReleaseImage(): Promise<string> {
  const token = getFlyApiToken();
  if (!token) {
    throw new Error('FLY_API_TOKEN is not configured');
  }

  const appName = getServerAppName();
  const query = `query { app(name: "${appName}") { currentRelease { imageRef } } }`;

  const response = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Fly GraphQL API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    data?: { app?: { currentRelease?: { imageRef?: string } } };
  };

  const imageRef = data.data?.app?.currentRelease?.imageRef;
  if (!imageRef) {
    throw new Error(`No current release found for app ${appName}`);
  }

  console.log(`[FlyService] Latest release image: ${imageRef}`);
  return imageRef;
}

// ============================================================================
// Volume Management
// ============================================================================

/**
 * List all volumes for the app
 */
export async function listVolumes(): Promise<FlyVolume[]> {
  return flyRequest<FlyVolume[]>('GET', `/apps/${getServerAppName()}/volumes`);
}

/**
 * Create a volume for persistent storage
 */
export async function createVolume(
  name: string,
  region: string,
  sizeGb: number = 1
): Promise<FlyVolume> {
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName()}/volumes`, {
    name,
    region,
    size_gb: sizeGb,
    encrypted: true,
  });
}

/**
 * Get a volume by ID
 */
export async function getVolume(volumeId: string): Promise<FlyVolume | null> {
  try {
    return await flyRequest<FlyVolume>('GET', `/apps/${getServerAppName()}/volumes/${volumeId}`);
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
  sizeGb: number = 1
): Promise<FlyVolume> {
  console.log(`[FlyService] Forking volume ${sourceVolumeId} to region ${region} (${sizeGb}GB)`);
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName()}/volumes`, {
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
export async function extendVolume(volumeId: string, newSizeGb: number): Promise<void> {
  await flyRequest<unknown>('PUT', `/apps/${getServerAppName()}/volumes/${volumeId}/extend`, {
    size_gb: newSizeGb,
  });
  console.log(`[FlyService] Extended volume ${volumeId} to ${newSizeGb}GB`);
}

/**
 * Create a volume from a snapshot (used for downsizing volumes)
 */
export async function createVolumeFromSnapshot(
  snapshotId: string,
  name: string,
  region: string,
  sizeGb: number
): Promise<FlyVolume> {
  console.log(`[FlyService] Creating volume from snapshot ${snapshotId} in ${region} (${sizeGb}GB)`);
  return flyRequest<FlyVolume>('POST', `/apps/${getServerAppName()}/volumes`, {
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
export async function deleteVolume(volumeId: string): Promise<void> {
  await flyRequest<void>('DELETE', `/apps/${getServerAppName()}/volumes/${volumeId}`);
  console.log(`[FlyService] Deleted volume ${volumeId}`);
}

/**
 * Create an on-demand snapshot of a volume (safety net before destructive operations)
 */
export async function createSnapshot(volumeId: string): Promise<{ id: string }> {
  const result = await flyRequest<{ Msg: { backup: { graph_id: string } } }>(
    'POST',
    `/apps/${getServerAppName()}/volumes/${volumeId}/snapshots`
  );
  const snapshotId = result.Msg?.backup?.graph_id || 'unknown';
  console.log(`[FlyService] Created snapshot ${snapshotId} for volume ${volumeId}`);
  return { id: snapshotId };
}

/**
 * List snapshots for a volume
 */
export async function listSnapshots(volumeId: string): Promise<Array<{ id: string; size: number; created_at: string }>> {
  return flyRequest<Array<{ id: string; size: number; created_at: string }>>(
    'GET',
    `/apps/${getServerAppName()}/volumes/${volumeId}/snapshots`
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
): Promise<string> {
  if (existingVolumeId) {
    try {
      const vol = await getVolume(existingVolumeId);
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
  const volume = await createVolume(volumeName, region, sizeGb);
  console.log(`[FlyService] Created volume ${volume.id} for server ${serverId}`);
  return volume.id;
}

// ============================================================================
// Machine Management
// ============================================================================

/**
 * List all machines in the app
 */
export async function listMachines(): Promise<FlyMachine[]> {
  return flyRequest<FlyMachine[]>('GET', `/apps/${getServerAppName()}/machines`);
}


/**
 * Get a machine by ID
 */
export async function getMachine(machineId: string): Promise<FlyMachine> {
  return flyRequest<FlyMachine>(
    'GET',
    `/apps/${getServerAppName()}/machines/${machineId}`
  );
}

/**
 * Update a machine's auto-suspend policy in-place.
 * Applies immediately via Fly Machines API.
 */
export async function updateMachineAutoSuspend(
  machineId: string,
  autoSuspendEnabled: boolean
): Promise<FlyMachine> {
  const machine = await getMachine(machineId);
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
    `/apps/${getServerAppName()}/machines/${machineId}`,
    payload
  );
}

/**
 * Ensure a machine has the specified tunnel token in its environment.
 * No-op when the token already matches.
 */
export async function ensureMachineTunnelToken(
  machineId: string,
  tunnelToken: string
): Promise<FlyMachine> {
  const machine = await getMachine(machineId);
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
    `/apps/${getServerAppName()}/machines/${machineId}`,
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
  const { serverId, serverToken, tunnelToken, region = 'iad', name, tier = 'shared-cpu-1x', existingVolumeId, autoSuspendEnabled } = options;
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

  // Get the latest release image and volume in parallel
  const [latestImage, volumeId] = await Promise.all([
    getLatestReleaseImage(),
    getOrCreateVolume(serverId, region, tierConfig.volume_gb, existingVolumeId),
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
        CLOUD_API_URL: process.env.CLOUD_API_URL || 'https://console.fishtank.bot',
        SERVER_SESSION_SECRET: process.env.SERVER_SESSION_SECRET || '',
        PREVIEW_DOMAIN: process.env.PREVIEW_DOMAIN || 'tank.fish',
        PORT: '3001',
        HOST: '0.0.0.0',
      },
      services: [
        {
          ports: [
            { port: 443, handlers: ['tls', 'http'] },
            { port: 80, handlers: ['http'] },
          ],
          protocol: 'tcp',
          internal_port: 3001,
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
          port: 3001,
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
    `/apps/${getServerAppName()}/machines`,
    machineConfig
  );

  // Construct the public URL (app-level URL, use Fly-Force-Instance-Id header for per-machine routing)
  const url = `https://${getServerAppName()}.fly.dev`;

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
  options?: { skipLaunch?: boolean },
): Promise<FlyMachine> {
  const machine = await getMachine(machineId);
  const updatedConfig = configModifier({ ...machine.config } as unknown as Record<string, unknown>);

  const queryParams = options?.skipLaunch ? '?skip_launch=true' : '';
  return flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName()}/machines/${machineId}${queryParams}`,
    { config: updatedConfig },
  );
}

/**
 * Start a stopped/suspended machine
 * Handles 409/412 errors if machine is already starting or active
 */
export async function startMachine(machineId: string): Promise<void> {
  console.log(`[FlyService] Starting machine ${machineId}`);
  try {
    await flyRequest<void>(
      'POST',
      `/apps/${getServerAppName()}/machines/${machineId}/start`
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
export async function stopMachine(machineId: string): Promise<void> {
  console.log(`[FlyService] Stopping machine ${machineId}`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName()}/machines/${machineId}/stop`
  );
}

/**
 * Suspend a machine (faster restart than stop)
 */
export async function suspendMachine(machineId: string): Promise<void> {
  console.log(`[FlyService] Suspending machine ${machineId}`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName()}/machines/${machineId}/suspend`
  );
}

/**
 * Restart a running machine in-place (preserves ephemeral filesystem).
 * Uses Fly.io's native restart endpoint which restarts the process
 * without rebuilding the container, so globally installed packages survive.
 */
export async function restartMachine(machineId: string): Promise<void> {
  console.log(`[FlyService] Restarting machine ${machineId} (in-place)`);
  await flyRequest<void>(
    'POST',
    `/apps/${getServerAppName()}/machines/${machineId}/restart`
  );
}

/**
 * Update a machine to the latest release image and restart it.
 * Fetches the current machine config, swaps the image to the latest release,
 * and issues an update via the Machines API (which also restarts the machine).
 */
export async function updateMachineImage(machineId: string): Promise<void> {
  const [machine, latestImage] = await Promise.all([
    getMachine(machineId),
    getLatestReleaseImage(),
  ]);

  if (machine.config.image === latestImage) {
    console.log(`[FlyService] Machine ${machineId} already on latest image, restarting in-place`);
    await restartMachine(machineId);
    return;
  }

  console.log(`[FlyService] Updating machine ${machineId} image: ${machine.config.image} → ${latestImage}`);

  await flyRequest<FlyMachine>(
    'POST',
    `/apps/${getServerAppName()}/machines/${machineId}`,
    {
      config: {
        ...machine.config,
        image: latestImage,
      },
    }
  );
}

/**
 * Delete a machine
 */
export async function deleteMachine(machineId: string): Promise<void> {
  console.log(`[FlyService] Deleting machine ${machineId}`);
  await flyRequest<void>(
    'DELETE',
    `/apps/${getServerAppName()}/machines/${machineId}?force=true`
  );
}

/**
 * Wait for a machine to reach a specific state
 */
export async function waitForMachine(
  machineId: string,
  targetStates: FlyMachineState[] = ['started'],
  timeoutMs: number = 90000
): Promise<FlyMachine> {
  const start = Date.now();
  const pollInterval = 500;

  console.log(`[FlyService] Waiting for machine ${machineId} to reach state: ${targetStates.join(' or ')}`);

  while (Date.now() - start < timeoutMs) {
    const machine = await getMachine(machineId);

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
  timeoutMs: number = 60000
): Promise<FlyMachine> {
  const start = Date.now();
  const pollInterval = 1000; // Poll every second

  console.log(`[FlyService] Waiting for machine ${machineId} to be healthy`);

  // Directly poll the machine's health endpoint through Fly.io routing
  const healthUrl = `https://${getServerAppName()}.fly.dev/health?fly_instance_id=${machineId}`;

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
        return await getMachine(machineId);
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
  return await getMachine(machineId);
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
