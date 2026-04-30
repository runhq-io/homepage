/**
 * Fly.io Provider
 *
 * Implements IProvider by delegating to the existing FlyService.
 * No logic changes — just maps between provider-agnostic types and Fly-specific types.
 */

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
import * as FlyService from '../FlyService';
import type { FlyMachineState, FlyMachine } from '../FlyService';
import type { ServerTier } from '../../../db/schema';

// ---------------------------------------------------------------------------
// Tier mapping: TierId ↔ Fly's ServerTier
// ---------------------------------------------------------------------------

// New tier IDs map 1:1 to ServerTier (same string)
const TIER_TO_FLY: Record<TierId, ServerTier> = {
  'shared-4x-1gb': 'shared-4x-1gb',
  'shared-4x-2gb': 'shared-4x-2gb',
  'shared-4x-4gb': 'shared-4x-4gb',
  'shared-4x-8gb': 'shared-4x-8gb',
  'shared-8x-4gb': 'shared-8x-4gb',
  'shared-8x-8gb': 'shared-8x-8gb',
  'shared-8x-16gb': 'shared-8x-16gb',
  'perf-2x-4gb': 'perf-2x-4gb',
  'perf-2x-8gb': 'perf-2x-8gb',
  'perf-2x-16gb': 'perf-2x-16gb',
  'perf-4x-8gb': 'perf-4x-8gb',
  'perf-4x-16gb': 'perf-4x-16gb',
  'perf-4x-32gb': 'perf-4x-32gb',
};

const TIER_ID_SET: Set<string> = new Set(Object.keys(TIER_TO_FLY));

// Map legacy ServerTier values (from existing DB rows) to closest new TierId
const FLY_TO_TIER: Partial<Record<ServerTier, TierId>> = {
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

export function flyTierToTierId(tier: ServerTier): TierId {
  // Pass through if already a new TierId
  if (TIER_ID_SET.has(tier)) return tier as TierId;
  return FLY_TO_TIER[tier] ?? 'shared-4x-2gb';
}

export function tierIdToFlyTier(tierId: TierId): ServerTier {
  return TIER_TO_FLY[tierId] ?? 'shared-4x-2gb';
}

// ---------------------------------------------------------------------------
// State mapping: FlyMachineState → MachineState
// ---------------------------------------------------------------------------

function mapFlyState(flyState: FlyMachineState): MachineState {
  switch (flyState) {
    case 'created':
      return 'creating';
    case 'starting':
      return 'starting';
    case 'started':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'stopped':
      return 'stopped';
    case 'suspended':
      return 'suspended';
    case 'replacing':
      return 'starting'; // replacing is effectively restarting
    case 'destroying':
      return 'destroying';
    case 'destroyed':
      return 'destroyed';
    default:
      return 'stopped';
  }
}

/** Map a normalized MachineState back to the Fly states it could represent */
function machineStateToFlyStates(state: MachineState): FlyMachineState[] {
  switch (state) {
    case 'creating':
      return ['created'];
    case 'starting':
      return ['starting', 'replacing'];
    case 'running':
      return ['started'];
    case 'stopping':
      return ['stopping'];
    case 'stopped':
      return ['stopped'];
    case 'suspended':
      return ['suspended'];
    case 'destroying':
      return ['destroying'];
    case 'destroyed':
      return ['destroyed'];
    default:
      return ['stopped'];
  }
}

function mapFlyMachine(m: FlyMachine): MachineInfo {
  return {
    id: m.id,
    name: m.name,
    state: mapFlyState(m.state),
    region: m.region,
  };
}

// ---------------------------------------------------------------------------
// FlyProvider
// ---------------------------------------------------------------------------

export class FlyProvider implements IProvider {
  readonly id: ProviderId = 'fly';

  // ---- Configuration ----

  isConfigured(): boolean {
    return FlyService.isConfigured();
  }

  getRegions(): Region[] {
    return [
      { id: 'iad', providerId: 'fly', providerRegion: 'iad', displayName: 'Virginia (US East)' },
      { id: 'ams', providerId: 'fly', providerRegion: 'ams', displayName: 'Amsterdam (Europe)' },
      { id: 'sin', providerId: 'fly', providerRegion: 'sin', displayName: 'Singapore (Asia)' },
      { id: 'gru', providerId: 'fly', providerRegion: 'gru', displayName: 'São Paulo (South America)' },
    ];
  }

  getTierSpecs(): TierSpec[] {
    return [
      // Shared 4x — diskGb must match FlyService.TIER_CONFIGS volume_gb AND client tiers.ts storage
      { tierId: 'shared-4x-1gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 1024,  diskGb: 12,  label: 'Shared 4x / 1 GB' },
      { tierId: 'shared-4x-2gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 2048,  diskGb: 20,  label: 'Shared 4x / 2 GB' },
      { tierId: 'shared-4x-4gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 4096,  diskGb: 40,  label: 'Shared 4x / 4 GB' },
      { tierId: 'shared-4x-8gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 8192,  diskGb: 40,  label: 'Shared 4x / 8 GB' },
      // Shared 8x
      { tierId: 'shared-8x-4gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 4096,  diskGb: 40,  label: 'Shared 8x / 4 GB' },
      { tierId: 'shared-8x-8gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 8192,  diskGb: 60,  label: 'Shared 8x / 8 GB' },
      { tierId: 'shared-8x-16gb', cpuKind: 'shared',      cpus: 8, memoryMb: 16384, diskGb: 80,  label: 'Shared 8x / 16 GB' },
      // Performance 2x
      { tierId: 'perf-2x-4gb',    cpuKind: 'performance', cpus: 2, memoryMb: 4096,  diskGb: 40,  label: 'Perf 2x / 4 GB' },
      { tierId: 'perf-2x-8gb',    cpuKind: 'performance', cpus: 2, memoryMb: 8192,  diskGb: 60,  label: 'Perf 2x / 8 GB' },
      { tierId: 'perf-2x-16gb',   cpuKind: 'performance', cpus: 2, memoryMb: 16384, diskGb: 80,  label: 'Perf 2x / 16 GB' },
      // Performance 4x
      { tierId: 'perf-4x-8gb',    cpuKind: 'performance', cpus: 4, memoryMb: 8192,  diskGb: 60,  label: 'Perf 4x / 8 GB' },
      { tierId: 'perf-4x-16gb',   cpuKind: 'performance', cpus: 4, memoryMb: 16384, diskGb: 100, label: 'Perf 4x / 16 GB' },
      { tierId: 'perf-4x-32gb',   cpuKind: 'performance', cpus: 4, memoryMb: 32768, diskGb: 160, label: 'Perf 4x / 32 GB' },
    ];
  }

  // ---- App / network lifecycle ----

  async createApp(appName: string, networkName: string): Promise<void> {
    await FlyService.createApp(appName, networkName);
  }

  async deleteApp(appName: string): Promise<void> {
    await FlyService.deleteApp(appName);
  }

  async allocateIPs(appName: string, opts?: { sharedV4?: boolean; v6?: boolean }): Promise<void> {
    await FlyService.allocateIPs(appName, opts);
  }

  async addCertificate(appName: string, hostname: string): Promise<void> {
    await FlyService.addCertificate(appName, hostname);
  }

  // ---- Machine lifecycle ----

  async createMachine(options: CreateMachineOptions): Promise<ProvisionResult> {
    const flyTier = tierIdToFlyTier(options.tier);
    const result = await FlyService.createMachine({
      serverId: options.serverId,
      serverToken: options.serverToken,
      tunnelToken: options.tunnelToken,
      region: options.region,
      tier: flyTier,
      existingVolumeId: options.existingVolumeId,
      autoSuspendEnabled: options.autoSuspendEnabled,
      appName: options.appName,
    });

    return {
      machineId: result.machineId,
      machineName: result.machineName,
      serverUrl: result.url,
      region: result.region,
      volumeId: result.volumeId,
      appName: options.appName ?? null,
      networkName: options.networkName ?? null,
    };
  }

  async getMachineState(machineId: string, appName?: string | null): Promise<MachineState> {
    const machine = await FlyService.getMachine(machineId, appName);
    return mapFlyState(machine.state);
  }

  async getMachineInfo(machineId: string, appName?: string | null): Promise<MachineInfo> {
    const machine = await FlyService.getMachine(machineId, appName);
    return mapFlyMachine(machine);
  }

  async startMachine(machineId: string, appName?: string | null): Promise<void> {
    await FlyService.startMachine(machineId, appName);
  }

  async stopMachine(
    machineId: string,
    appName?: string | null,
    options?: { disableAutostart?: boolean },
  ): Promise<void> {
    await FlyService.stopMachine(machineId, appName, options);
  }

  async suspendMachine(machineId: string, appName?: string | null): Promise<void> {
    await FlyService.suspendMachine(machineId, appName);
  }

  async restartMachine(machineId: string, appName?: string | null): Promise<void> {
    await FlyService.restartMachine(machineId, appName);
  }

  async updateMachineImage(machineId: string, appName?: string | null): Promise<void> {
    await FlyService.updateMachineImage(machineId, appName);
  }

  async deleteMachine(machineId: string, appName?: string | null): Promise<void> {
    await FlyService.deleteMachine(machineId, appName);
  }

  // ---- Volume management ----

  async createVolume(name: string, region: string, sizeGb?: number, appName?: string | null): Promise<VolumeInfo> {
    const vol = await FlyService.createVolume(name, region, sizeGb, appName);
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async getVolume(volumeId: string, appName?: string | null): Promise<VolumeInfo | null> {
    const vol = await FlyService.getVolume(volumeId, appName);
    if (!vol) return null;
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async extendVolume(volumeId: string, newSizeGb: number, appName?: string | null): Promise<void> {
    await FlyService.extendVolume(volumeId, newSizeGb, appName);
  }

  async createVolumeFromSnapshot(snapshotId: string, name: string, region: string, sizeGb: number, appName?: string | null): Promise<VolumeInfo> {
    const vol = await FlyService.createVolumeFromSnapshot(snapshotId, name, region, sizeGb, appName);
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async forkVolume(sourceVolumeId: string, name: string, region: string, sizeGb?: number, appName?: string | null): Promise<VolumeInfo> {
    const vol = await FlyService.forkVolume(sourceVolumeId, name, region, sizeGb, appName);
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async createSnapshot(volumeId: string, appName?: string | null): Promise<SnapshotInfo> {
    return FlyService.createSnapshot(volumeId, appName);
  }

  async deleteVolume(volumeId: string, appName?: string | null): Promise<void> {
    await FlyService.deleteVolume(volumeId, appName);
  }

  async waitForVolumeReady(volumeId: string, appName?: string | null, timeoutMs?: number): Promise<void> {
    await FlyService.waitForVolumeReady(volumeId, appName, timeoutMs);
  }

  // ---- Health / waiting ----

  async waitForState(machineId: string, targetStates: MachineState[], timeoutMs?: number, appName?: string | null): Promise<void> {
    // Expand normalized states into Fly states
    const flyStates = targetStates.flatMap(machineStateToFlyStates);
    await FlyService.waitForMachine(machineId, flyStates, timeoutMs, appName);
  }

  async waitForHealthy(machineId: string, timeoutMs?: number, appName?: string | null): Promise<void> {
    await FlyService.waitForMachineHealthy(machineId, timeoutMs, appName);
  }

  // ---- Routing ----

  getRoutingInfo(machineId: string, appName?: string | null): RoutingInfo {
    // TODO: Switch to per-machine Cloudflare Tunnel URLs once all machines are backfilled.
    // For now, use Fly's shared proxy — tunnel DNS records (srv-{machineId}.runhq.io) don't
    // exist yet for most machines. The ensureServerTunnelConnector() backfill creates them
    // during wake/provision, but we need a one-time backfill for existing machines first.
    const app = appName || FlyService.getServerAppNamePublic();
    const serverUrl = `https://${app}.fly.dev`;
    return {
      serverUrl,
      routingToken: machineId,
      requiresRoutingHeaders: true,
    };
  }

  // ---- Machine config updates ----

  async updateAutoSuspendPolicy(machineId: string, autoSuspendEnabled: boolean, appName?: string | null): Promise<void> {
    await FlyService.updateMachineAutoSuspend(machineId, autoSuspendEnabled, appName);
  }

  async updateMachineEnv(machineId: string, env: Record<string, string>, appName?: string | null): Promise<void> {
    // Use ensureMachineTunnelToken for TUNNEL_TOKEN, or updateMachineConfig for generic env
    if (env.TUNNEL_TOKEN) {
      await FlyService.ensureMachineTunnelToken(machineId, env.TUNNEL_TOKEN, appName);
    }
  }

  // ---- Fleet ----

  async listMachines(appName?: string | null): Promise<MachineInfo[]> {
    const machines = await FlyService.listMachines(appName);
    return machines.map(mapFlyMachine);
  }
}
