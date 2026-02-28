/**
 * Hetzner Cloud Service
 *
 * Raw HTTP wrapper for the Hetzner Cloud API.
 * - Create/delete/manage cloud servers
 * - Create/delete/attach/detach volumes
 * - Poll actions until completion
 */

// Hetzner Cloud API base URL
const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

// ============================================================================
// Configuration
// ============================================================================

// Read env var at runtime (not module load time, to ensure dotenv has loaded)
function getHetznerApiToken(): string | undefined {
  return process.env.HETZNER_API_TOKEN;
}

/**
 * Check if Hetzner Cloud API is configured and available
 */
export function isConfigured(): boolean {
  return !!getHetznerApiToken();
}

// ============================================================================
// Types
// ============================================================================

export type HetznerServerStatus =
  | 'initializing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'off'
  | 'deleting'
  | 'migrating'
  | 'rebuilding'
  | 'unknown';

export interface HetznerServer {
  id: number;
  name: string;
  status: HetznerServerStatus;
  public_net: {
    ipv4: { ip: string } | null;
    ipv6: { ip: string } | null;
  };
  server_type: { name: string; description: string };
  datacenter: { name: string; location: { name: string } };
  image: { id: number; name: string } | null;
  created: string;
}

export interface HetznerVolume {
  id: number;
  name: string;
  size: number; // GB
  server: number | null;
  status: string;
  location: { name: string };
  created: string;
}

export interface HetznerAction {
  id: number;
  status: 'running' | 'success' | 'error';
  progress: number;
  started: string;
  finished: string | null;
  error?: { code: string; message: string };
}

// ============================================================================
// API Helper
// ============================================================================

async function hetznerRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = getHetznerApiToken();
  if (!token) {
    throw new Error('HETZNER_API_TOKEN is not configured');
  }

  const url = `${HETZNER_API_URL}${path}`;
  console.log(`[HetznerService] ${method} ${url}`);

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[HetznerService] API error: ${response.status} - ${errorText}`);
    throw new Error(`Hetzner API error: ${response.status} - ${errorText}`);
  }

  // 204 No Content — nothing to parse
  if (response.status === 204) {
    return {} as T;
  }

  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

// ============================================================================
// Server Management
// ============================================================================

export interface CreateServerOptions {
  name: string;
  serverType: string;
  location: string;
  image: string;
  userData?: string;
  labels?: Record<string, string>;
  volumes?: number[];
  sshKeys?: number[];
}

export interface CreateServerResult {
  server: HetznerServer;
  action: HetznerAction;
  root_password: string | null;
}

/**
 * Create a new cloud server
 */
export async function createServer(opts: CreateServerOptions): Promise<CreateServerResult> {
  console.log(
    `[HetznerService] Creating server "${opts.name}" (type: ${opts.serverType}, location: ${opts.location}, image: ${opts.image})`
  );

  return hetznerRequest<CreateServerResult>('POST', '/servers', {
    name: opts.name,
    server_type: opts.serverType,
    location: opts.location,
    image: opts.image,
    user_data: opts.userData,
    labels: opts.labels,
    volumes: opts.volumes,
    ...(opts.sshKeys?.length ? { ssh_keys: opts.sshKeys } : {}),
  });
}

/**
 * Get a server by ID
 */
export async function getServer(serverId: number): Promise<HetznerServer> {
  const result = await hetznerRequest<{ server: HetznerServer }>('GET', `/servers/${serverId}`);
  return result.server;
}

/**
 * Delete a server (destroys it permanently)
 */
export async function deleteServer(serverId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Deleting server ${serverId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>('DELETE', `/servers/${serverId}`);
  return result.action;
}

/**
 * Power on a stopped server
 */
export async function powerOn(serverId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Powering on server ${serverId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>(
    'POST',
    `/servers/${serverId}/actions/poweron`
  );
  return result.action;
}

/**
 * Power off a server (hard shutdown — no graceful OS shutdown)
 */
export async function powerOff(serverId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Powering off server ${serverId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>(
    'POST',
    `/servers/${serverId}/actions/poweroff`
  );
  return result.action;
}

/**
 * Reboot a server (soft reset via ACPI)
 */
export async function reboot(serverId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Rebooting server ${serverId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>(
    'POST',
    `/servers/${serverId}/actions/reboot`
  );
  return result.action;
}

/**
 * Reset the root password of a server. Hetzner generates a new random password.
 */
export async function resetRootPassword(
  serverId: number
): Promise<{ action: HetznerAction; root_password: string }> {
  console.log(`[HetznerService] Resetting root password for server ${serverId}`);
  return hetznerRequest<{ action: HetznerAction; root_password: string }>(
    'POST',
    `/servers/${serverId}/actions/reset_password`
  );
}

/**
 * List all servers, optionally filtered by label selector.
 * Label selector syntax: "env=production" or "env=production,app=web"
 */
export async function listServers(labelSelector?: string): Promise<HetznerServer[]> {
  let path = '/servers';
  if (labelSelector) {
    path += `?label_selector=${encodeURIComponent(labelSelector)}`;
  }
  const result = await hetznerRequest<{ servers: HetznerServer[] }>('GET', path);
  return result.servers;
}

// ============================================================================
// Volume Management
// ============================================================================

export interface CreateVolumeOptions {
  name: string;
  size: number; // GB
  location: string;
  labels?: Record<string, string>;
}

export interface CreateVolumeResult {
  volume: HetznerVolume;
  action: HetznerAction;
}

/**
 * Create a new volume
 */
export async function createVolume(opts: CreateVolumeOptions): Promise<CreateVolumeResult> {
  console.log(
    `[HetznerService] Creating volume "${opts.name}" (${opts.size}GB, location: ${opts.location})`
  );

  const result = await hetznerRequest<{ volume: HetznerVolume; action: HetznerAction }>(
    'POST',
    '/volumes',
    {
      name: opts.name,
      size: opts.size,
      location: opts.location,
      labels: opts.labels,
      automount: false,
      format: 'ext4',
    }
  );

  return { volume: result.volume, action: result.action };
}

/**
 * Get a volume by ID
 */
export async function getVolume(volumeId: number): Promise<HetznerVolume> {
  const result = await hetznerRequest<{ volume: HetznerVolume }>('GET', `/volumes/${volumeId}`);
  return result.volume;
}

/**
 * Delete a volume (must be detached first)
 */
export async function deleteVolume(volumeId: number): Promise<void> {
  console.log(`[HetznerService] Deleting volume ${volumeId}`);
  await hetznerRequest<void>('DELETE', `/volumes/${volumeId}`);
}

/**
 * Attach a volume to a server
 */
export async function attachVolume(volumeId: number, serverId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Attaching volume ${volumeId} to server ${serverId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>(
    'POST',
    `/volumes/${volumeId}/actions/attach`,
    { server: serverId, automount: true }
  );
  return result.action;
}

/**
 * Detach a volume from its currently attached server
 */
export async function detachVolume(volumeId: number): Promise<HetznerAction> {
  console.log(`[HetznerService] Detaching volume ${volumeId}`);
  const result = await hetznerRequest<{ action: HetznerAction }>(
    'POST',
    `/volumes/${volumeId}/actions/detach`
  );
  return result.action;
}

// ============================================================================
// Action Polling
// ============================================================================

/**
 * Get an action by ID
 */
export async function getAction(actionId: number): Promise<HetznerAction> {
  const result = await hetznerRequest<{ action: HetznerAction }>('GET', `/actions/${actionId}`);
  return result.action;
}

/**
 * Poll an action until it completes or times out.
 * Polls every 2 seconds by default. Throws on action error or timeout.
 */
export async function waitForAction(
  actionId: number,
  timeoutMs: number = 300_000
): Promise<HetznerAction> {
  const start = Date.now();
  const pollInterval = 2000;

  console.log(`[HetznerService] Waiting for action ${actionId} to complete`);

  while (Date.now() - start < timeoutMs) {
    const action = await getAction(actionId);

    if (action.status === 'success') {
      console.log(`[HetznerService] Action ${actionId} completed successfully`);
      return action;
    }

    if (action.status === 'error') {
      const errMsg = action.error
        ? `${action.error.code}: ${action.error.message}`
        : 'unknown error';
      throw new Error(`Hetzner action ${actionId} failed: ${errMsg}`);
    }

    // Still running — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for Hetzner action ${actionId} after ${timeoutMs}ms`
  );
}
