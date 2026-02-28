/**
 * Hetzner Cloud Provider
 *
 * Implements IProvider by delegating to the existing HetznerService.
 * Hetzner servers are routed through Cloudflare Tunnels (when configured)
 * for TLS and IP hiding, falling back to direct public IPv4 access.
 * createMachine sets up a cloud-init script that installs Docker, pulls
 * the fishtank server image, and runs it with the data volume mounted.
 */

import { nanoid } from 'nanoid';
import type { IProvider } from './IProvider';
import type {
  ProviderId,
  MachineState,
  TierId,
  TierSpec,
  Region,
  CreateMachineOptions,
  ProvisionResult,
  RoutingInfo,
  VolumeInfo,
  SnapshotInfo,
  MachineInfo,
} from './types';
import * as HetznerService from '../HetznerService';
import type { HetznerServerStatus } from '../HetznerService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FISHTANK_LABEL = 'fishtank';
const LABEL_SELECTOR = `app=${FISHTANK_LABEL}`;

function getServerImage(): string {
  return process.env.HETZNER_SERVER_IMAGE || 'registry.fly.io/fishtank-workspaces:deployment-01KJ9PE1S6N63CW3CK6W02N9JG';
}

/** Optional registry credentials for pulling the server image on Hetzner machines */
function getRegistryAuth(): { server: string; user: string; password: string } | null {
  // Support explicit registry credentials
  if (process.env.HETZNER_REGISTRY_PASSWORD) {
    return {
      server: process.env.HETZNER_REGISTRY_SERVER || 'registry.fly.io',
      user: process.env.HETZNER_REGISTRY_USER || 'x',
      password: process.env.HETZNER_REGISTRY_PASSWORD,
    };
  }
  // Fall back to Fly token for registry.fly.io images
  if (getServerImage().startsWith('registry.fly.io/') && process.env.FLY_API_TOKEN) {
    return {
      server: 'registry.fly.io',
      user: 'x',
      password: process.env.FLY_API_TOKEN,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier mapping: TierId → Hetzner server type
// ---------------------------------------------------------------------------

const TIER_TO_HETZNER: Record<TierId, string> = {
  micro: 'cpx21',   // 3 vCPU, 4 GB — available all locations
  small: 'cpx31',   // 4 vCPU, 8 GB — available all locations
  medium: 'cpx41',  // 8 vCPU, 16 GB — available all locations
  large: 'cpx51',   // 16 vCPU, 32 GB — available all locations
};

const TIER_DISK_GB: Record<TierId, number> = {
  micro: 10,
  small: 10,
  medium: 10,
  large: 20,
};

// ---------------------------------------------------------------------------
// State mapping: HetznerServerStatus → MachineState
// ---------------------------------------------------------------------------

function mapHetznerState(status: HetznerServerStatus): MachineState {
  switch (status) {
    case 'initializing':
      return 'creating';
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'off':
      return 'stopped';
    case 'deleting':
      return 'destroying';
    case 'migrating':
      return 'starting';
    case 'rebuilding':
      return 'starting';
    case 'unknown':
    default:
      return 'stopped';
  }
}

function mapHetznerServer(s: HetznerService.HetznerServer): MachineInfo {
  return {
    id: String(s.id),
    name: s.name,
    state: mapHetznerState(s.status),
    region: s.datacenter.location.name,
  };
}

// ---------------------------------------------------------------------------
// Cloud-init user-data generation
// ---------------------------------------------------------------------------

function buildCloudInit(opts: {
  serverToken: string;
  image: string;
  volumeDevice: string;
  cloudApiUrl?: string;
  registryAuth?: { server: string; user: string; password: string } | null;
  tunnelToken?: string | null;
}): string {
  const cloudApiUrl = opts.cloudApiUrl || process.env.CLOUD_API_URL || 'https://console.fishtank.bot';
  const lines: string[] = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# --- Install Docker CE ---',
    'apt-get update -qq',
    'apt-get install -y -qq ca-certificates curl gnupg',
    'install -m 0755 -d /etc/apt/keyrings',
    'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg',
    'chmod a+r /etc/apt/keyrings/docker.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
    'apt-get update -qq',
    'apt-get install -y -qq docker-ce docker-ce-cli containerd.io',
    'systemctl enable --now docker',
    '',
    '# --- Mount data volume ---',
    `mkdir -p /mnt/data`,
    `if ! blkid ${opts.volumeDevice}; then mkfs.ext4 ${opts.volumeDevice}; fi`,
    `mount ${opts.volumeDevice} /mnt/data`,
    `echo '${opts.volumeDevice} /mnt/data ext4 defaults 0 2' >> /etc/fstab`,
    '',
  ];

  // Registry authentication (for private registries like registry.fly.io or ghcr.io)
  if (opts.registryAuth) {
    lines.push(
      '# --- Registry auth ---',
      `echo '${opts.registryAuth.password}' | docker login ${opts.registryAuth.server} -u ${opts.registryAuth.user} --password-stdin`,
      '',
    );
  }

  const tunnelEnv = opts.tunnelToken ? `  -e TUNNEL_TOKEN=${opts.tunnelToken} \\\n` : '';
  lines.push(
    '# --- Pull and run fishtank server ---',
    `docker pull ${opts.image}`,
    `docker run -d \\`,
    `  --name fishtank-server \\`,
    `  --restart unless-stopped \\`,
    `  -e SERVER_TOKEN=${opts.serverToken} \\`,
    `  -e CLOUD_API_URL=${cloudApiUrl} \\`,
    `  -e HOST=0.0.0.0 \\`,
    `  -e PORT=3001 \\`,
    `${tunnelEnv}  -v /mnt/data:/app/data \\`,
    `  -p 3001:3001 \\`,
    `  ${opts.image}`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseId(machineId: string): number {
  const id = Number(machineId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Invalid Hetzner machine ID: "${machineId}"`);
  }
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HetznerProvider
// ---------------------------------------------------------------------------

export class HetznerProvider implements IProvider {
  readonly id: ProviderId = 'hetzner';

  // ---- Configuration ----

  isConfigured(): boolean {
    return HetznerService.isConfigured();
  }

  getRegions(): Region[] {
    return [
      { id: 'ash', providerId: 'hetzner', providerRegion: 'ash', displayName: 'Ashburn, VA (US East)' },
      { id: 'hil', providerId: 'hetzner', providerRegion: 'hil', displayName: 'Hillsboro, OR (US West)' },
      { id: 'fsn1', providerId: 'hetzner', providerRegion: 'fsn1', displayName: 'Falkenstein (Germany)' },
      { id: 'nbg1', providerId: 'hetzner', providerRegion: 'nbg1', displayName: 'Nuremberg (Germany)' },
      { id: 'hel1', providerId: 'hetzner', providerRegion: 'hel1', displayName: 'Helsinki (Finland)' },
      { id: 'sin', providerId: 'hetzner', providerRegion: 'sin', displayName: 'Singapore (Asia)' },
    ];
  }

  getTierSpecs(): TierSpec[] {
    return [
      { tierId: 'micro', cpus: 3, memoryMb: 4096, diskGb: 10, label: 'Micro — CPX21 (3 vCPU / 4GB)' },
      { tierId: 'small', cpus: 4, memoryMb: 8192, diskGb: 10, label: 'Small — CPX31 (4 vCPU / 8GB)' },
      { tierId: 'medium', cpus: 8, memoryMb: 16384, diskGb: 10, label: 'Medium — CPX41 (8 vCPU / 16GB)' },
      { tierId: 'large', cpus: 16, memoryMb: 32768, diskGb: 20, label: 'Large — CPX51 (16 vCPU / 32GB)' },
    ];
  }

  // ---- Machine lifecycle ----

  async createMachine(options: CreateMachineOptions): Promise<ProvisionResult> {
    const { serverId, serverToken, tunnelToken, region, tier, existingVolumeId } = options;

    const hetznerType = TIER_TO_HETZNER[tier] ?? 'cpx21';
    const diskGb = TIER_DISK_GB[tier] ?? 10;
    // Hetzner hostnames only allow [a-zA-Z0-9-], so replace underscores
    const safeName = serverId.replace(/_/g, '-');
    const machineName = `srv-${safeName}-${nanoid(6)}`;
    const image = getServerImage();

    // Create or reuse a volume
    let volumeId: string;
    let hetznerVolumeId: number;

    if (existingVolumeId) {
      hetznerVolumeId = parseId(existingVolumeId);
      volumeId = existingVolumeId;
    } else {
      const volResult = await HetznerService.createVolume({
        name: `vol-${safeName}-${nanoid(6)}`,
        size: diskGb,
        location: region,
        labels: { app: FISHTANK_LABEL, server: serverId },
      });
      await HetznerService.waitForAction(volResult.action.id);
      hetznerVolumeId = volResult.volume.id;
      volumeId = String(volResult.volume.id);
    }

    // The Hetzner volume device path follows the pattern /dev/disk/by-id/scsi-0HC_Volume_<id>
    const volumeDevice = `/dev/disk/by-id/scsi-0HC_Volume_${hetznerVolumeId}`;

    const userData = buildCloudInit({
      serverToken,
      image,
      volumeDevice,
      registryAuth: getRegistryAuth(),
      tunnelToken,
    });

    // Create the server with the volume attached
    const sshKeyId = process.env.HETZNER_SSH_KEY_ID ? Number(process.env.HETZNER_SSH_KEY_ID) : undefined;
    let result;
    try {
      result = await HetznerService.createServer({
        name: machineName,
        serverType: hetznerType,
        location: region,
        image: 'ubuntu-24.04',
        userData,
        labels: { app: FISHTANK_LABEL, server: serverId },
        volumes: [hetznerVolumeId],
        ...(sshKeyId ? { sshKeys: [sshKeyId] } : {}),
      });

      // Wait for the create action to complete
      await HetznerService.waitForAction(result.action.id);
    } catch (error) {
      // Clean up the volume we just created if server creation failed
      if (!existingVolumeId) {
        try {
          await HetznerService.deleteVolume(hetznerVolumeId);
          console.log(`[HetznerProvider] Cleaned up orphaned volume ${hetznerVolumeId}`);
        } catch (cleanupErr) {
          console.error(`[HetznerProvider] Failed to clean up volume ${hetznerVolumeId}:`, cleanupErr);
        }
      }
      throw error;
    }

    // Wait for the server to reach running state
    const hetznerServerId = result.server.id;
    await this.waitForState(String(hetznerServerId), ['running'], 120_000);

    // Use tunnel URL when available (hides raw IP, provides TLS), fall back to direct IP
    let serverUrl: string;
    if (options.tunnelToken) {
      const domain = process.env.PUBLIC_PORTS_DOMAIN || 'tank.fish';
      serverUrl = `https://srv-${hetznerServerId}.${domain}`;
    } else {
      const hetznerServer = await HetznerService.getServer(hetznerServerId);
      const ip = hetznerServer.public_net.ipv4?.ip;
      if (!ip) {
        throw new Error(`Hetzner server ${hetznerServerId} has no public IPv4 address`);
      }
      serverUrl = `http://${ip}:3001`;
    }

    return {
      machineId: String(hetznerServerId),
      machineName,
      serverUrl,
      region,
      volumeId,
      rootPassword: result.root_password || undefined,
    };
  }

  async getMachineState(machineId: string): Promise<MachineState> {
    const server = await HetznerService.getServer(parseId(machineId));
    return mapHetznerState(server.status);
  }

  async getMachineInfo(machineId: string): Promise<MachineInfo> {
    const server = await HetznerService.getServer(parseId(machineId));
    return mapHetznerServer(server);
  }

  async startMachine(machineId: string): Promise<void> {
    const action = await HetznerService.powerOn(parseId(machineId));
    await HetznerService.waitForAction(action.id);
  }

  async stopMachine(machineId: string): Promise<void> {
    const action = await HetznerService.powerOff(parseId(machineId));
    await HetznerService.waitForAction(action.id);
  }

  async suspendMachine(machineId: string): Promise<void> {
    // Hetzner has no suspend — power off instead
    await this.stopMachine(machineId);
  }

  async restartMachine(machineId: string): Promise<void> {
    const action = await HetznerService.reboot(parseId(machineId));
    await HetznerService.waitForAction(action.id);
  }

  async resetRootPassword(machineId: string): Promise<string> {
    const result = await HetznerService.resetRootPassword(parseId(machineId));
    await HetznerService.waitForAction(result.action.id);
    return result.root_password;
  }

  async updateMachineImage(machineId: string): Promise<void> {
    // SSH into the server and pull the latest image, then restart the container.
    // Hetzner doesn't have a native "image update" API — we rely on the
    // server's Docker daemon to pull the new image.
    const server = await HetznerService.getServer(parseId(machineId));
    const ip = server.public_net.ipv4?.ip;
    if (!ip) {
      throw new Error(`Hetzner server ${machineId} has no public IPv4 address`);
    }

    const image = getServerImage();
    console.log(`[HetznerProvider] Updating image on server ${machineId} (${ip}) to ${image}`);

    // We use the Hetzner API to execute commands — but Hetzner has no exec API.
    // Instead we use Node's child_process to SSH. The server was provisioned with
    // root access and cloud-init; in production, an SSH key should be configured
    // via HETZNER_SSH_KEY_ID env var.
    const { execSync } = await import('child_process');
    const sshOpts = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10';
    const cmd = `docker pull ${image} && docker stop fishtank-server && docker rm fishtank-server && docker run -d --name fishtank-server --restart unless-stopped $(docker inspect fishtank-server 2>/dev/null | jq -r '.[0].Config.Env[]' | sed 's/^/-e /' | tr '\\n' ' ') -v /mnt/data:/app/data -p 3001:3001 ${image}`;

    try {
      execSync(`ssh ${sshOpts} root@${ip} '${cmd}'`, { timeout: 120_000 });
    } catch (err) {
      // Fallback: simpler pull + restart (container keeps running config)
      console.warn(`[HetznerProvider] Full image update failed, trying pull+restart: ${err}`);
      execSync(
        `ssh ${sshOpts} root@${ip} 'docker pull ${image} && docker restart fishtank-server'`,
        { timeout: 120_000 }
      );
    }
  }

  async deleteMachine(machineId: string): Promise<void> {
    console.log(`[HetznerProvider] Deleting server ${machineId}`);
    await HetznerService.deleteServer(parseId(machineId));
    // Don't waitForAction — Hetzner handles deletion async, no need to block
  }

  // ---- Volume management ----

  async createVolume(name: string, region: string, sizeGb?: number): Promise<VolumeInfo> {
    const result = await HetznerService.createVolume({
      name,
      size: sizeGb ?? 1,
      location: region,
      labels: { app: FISHTANK_LABEL },
    });
    await HetznerService.waitForAction(result.action.id);

    const vol = result.volume;
    return {
      id: String(vol.id),
      name: vol.name,
      state: vol.status,
      sizeGb: vol.size,
      region: vol.location.name,
    };
  }

  async getVolume(volumeId: string): Promise<VolumeInfo | null> {
    try {
      const vol = await HetznerService.getVolume(parseId(volumeId));
      return {
        id: String(vol.id),
        name: vol.name,
        state: vol.status,
        sizeGb: vol.size,
        region: vol.location.name,
      };
    } catch {
      return null;
    }
  }

  async forkVolume(
    _sourceVolumeId: string,
    name: string,
    region: string,
    sizeGb?: number
  ): Promise<VolumeInfo> {
    // Hetzner doesn't support cross-location volume cloning.
    // Create a new empty volume instead.
    console.warn(
      `[HetznerProvider] forkVolume: Hetzner does not support volume cloning. Creating new empty volume.`
    );
    return this.createVolume(name, region, sizeGb);
  }

  async createSnapshot(_volumeId: string): Promise<SnapshotInfo> {
    // Hetzner volume snapshots are not supported in this provider.
    // Return a dummy ID so callers that store snapshot references don't break.
    console.warn(`[HetznerProvider] createSnapshot: not supported on Hetzner, returning dummy ID`);
    return { id: `hetzner-unsupported-${Date.now()}` };
  }

  async deleteVolume(volumeId: string): Promise<void> {
    await HetznerService.deleteVolume(parseId(volumeId));
  }

  // ---- Health / waiting ----

  async waitForState(
    machineId: string,
    targetStates: MachineState[],
    timeoutMs: number = 120_000
  ): Promise<void> {
    const start = Date.now();
    const pollInterval = 3000;

    console.log(
      `[HetznerProvider] Waiting for machine ${machineId} to reach state: ${targetStates.join(', ')}`
    );

    while (Date.now() - start < timeoutMs) {
      const currentState = await this.getMachineState(machineId);
      if (targetStates.includes(currentState)) {
        console.log(`[HetznerProvider] Machine ${machineId} reached state: ${currentState}`);
        return;
      }
      await sleep(pollInterval);
    }

    throw new Error(
      `Timeout waiting for Hetzner machine ${machineId} to reach ${targetStates.join('|')} after ${timeoutMs}ms`
    );
  }

  async waitForHealthy(machineId: string, timeoutMs: number = 300_000): Promise<void> {
    const start = Date.now();
    const pollInterval = 5000;

    // First, ensure the machine is running
    await this.waitForState(machineId, ['running'], timeoutMs);

    const server = await HetznerService.getServer(parseId(machineId));
    const ip = server.public_net.ipv4?.ip;
    if (!ip) {
      throw new Error(`Hetzner server ${machineId} has no public IPv4 address for health check`);
    }

    const healthUrl = `http://${ip}:3001/health`;
    console.log(`[HetznerProvider] Polling health endpoint: ${healthUrl}`);

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          console.log(`[HetznerProvider] Machine ${machineId} is healthy`);
          return;
        }
      } catch {
        // Not ready yet — keep polling
      }
      await sleep(pollInterval);
    }

    throw new Error(
      `Timeout waiting for Hetzner machine ${machineId} to become healthy after ${timeoutMs}ms`
    );
  }

  // ---- Routing ----

  getRoutingInfo(machineId: string): RoutingInfo {
    // Route through Cloudflare Tunnel for TLS + IP hiding (when configured)
    if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID) {
      const domain = process.env.PUBLIC_PORTS_DOMAIN || 'tank.fish';
      return {
        serverUrl: `https://srv-${machineId}.${domain}`,
        routingToken: null,
        requiresRoutingHeaders: false,
      };
    }
    // Fallback: no tunnel configured, use DB serverUrl (empty string tells caller to use DB value)
    return {
      serverUrl: '',
      routingToken: null,
      requiresRoutingHeaders: false,
    };
  }

  // ---- Machine config updates ----

  async updateAutoSuspendPolicy(
    _machineId: string,
    _autoSuspendEnabled: boolean
  ): Promise<void> {
    // No-op for Hetzner — idle detection and auto-suspend are handled externally
  }

  async updateMachineEnv(machineId: string, env: Record<string, string>): Promise<void> {
    // SSH into the server and update the container's environment variables
    const server = await HetznerService.getServer(parseId(machineId));
    const ip = server.public_net.ipv4?.ip;
    if (!ip) {
      throw new Error(`Hetzner server ${machineId} has no public IPv4 address`);
    }

    // Build docker update command: stop container, recreate with new env vars
    const envFlags = Object.entries(env)
      .map(([k, v]) => `-e ${k}=${v}`)
      .join(' ');

    const image = getServerImage();
    const { execSync } = await import('child_process');
    const sshOpts = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10';

    // Export current env, merge new values, recreate container
    const cmd = [
      // Get existing env vars from the running container
      `EXISTING_ENV=$(docker inspect fishtank-server 2>/dev/null | jq -r '.[0].Config.Env[]' | grep -v '^${Object.keys(env).join('\\|^')}' | sed 's/^/-e /' | tr '\\n' ' ')`,
      'docker stop fishtank-server',
      'docker rm fishtank-server',
      `docker run -d --name fishtank-server --restart unless-stopped $EXISTING_ENV ${envFlags} -v /mnt/data:/app/data -p 3001:3001 ${image}`,
    ].join(' && ');

    execSync(`ssh ${sshOpts} root@${ip} '${cmd}'`, { timeout: 60_000 });
  }

  // ---- Fleet ----

  async listMachines(): Promise<MachineInfo[]> {
    const servers = await HetznerService.listServers(LABEL_SELECTOR);
    return servers.map(mapHetznerServer);
  }
}
