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

const TIER_TO_FLY: Record<TierId, ServerTier> = {
  micro: 'shared-cpu-1x',
  small: 'shared-cpu-2x',
  medium: 'shared-cpu-4x',
  large: 'shared-cpu-4x',
};

const TIER_ID_SET: Set<string> = new Set(['micro', 'small', 'medium', 'large']);

const FLY_TO_TIER: Partial<Record<ServerTier, TierId>> = {
  'shared-cpu-1x': 'micro',
  'shared-cpu-2x': 'small',
  'shared-cpu-4x': 'medium',
  'performance-cpu-2x': 'medium',
  'performance-cpu-4x': 'large',
};

export function flyTierToTierId(tier: ServerTier): TierId {
  // Pass through if already a generic TierId
  if (TIER_ID_SET.has(tier)) return tier as TierId;
  return FLY_TO_TIER[tier] ?? 'micro';
}

export function tierIdToFlyTier(tierId: TierId): ServerTier {
  return TIER_TO_FLY[tierId] ?? 'shared-cpu-1x';
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
      { tierId: 'micro', cpus: 1, memoryMb: 2048, diskGb: 1, label: 'Micro (1 vCPU / 2GB)' },
      { tierId: 'small', cpus: 2, memoryMb: 4096, diskGb: 5, label: 'Small (2 vCPU / 4GB)' },
      { tierId: 'medium', cpus: 4, memoryMb: 4096, diskGb: 10, label: 'Medium (4 vCPU / 4GB)' },
      { tierId: 'large', cpus: 4, memoryMb: 8192, diskGb: 20, label: 'Large (4 vCPU / 8GB)' },
    ];
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
    });

    return {
      machineId: result.machineId,
      machineName: result.machineName,
      serverUrl: result.url,
      region: result.region,
      volumeId: result.volumeId,
    };
  }

  async getMachineState(machineId: string): Promise<MachineState> {
    const machine = await FlyService.getMachine(machineId);
    return mapFlyState(machine.state);
  }

  async getMachineInfo(machineId: string): Promise<MachineInfo> {
    const machine = await FlyService.getMachine(machineId);
    return mapFlyMachine(machine);
  }

  async startMachine(machineId: string): Promise<void> {
    await FlyService.startMachine(machineId);
  }

  async stopMachine(machineId: string): Promise<void> {
    await FlyService.stopMachine(machineId);
  }

  async suspendMachine(machineId: string): Promise<void> {
    await FlyService.suspendMachine(machineId);
  }

  async restartMachine(machineId: string): Promise<void> {
    await FlyService.restartMachine(machineId);
  }

  async updateMachineImage(machineId: string): Promise<void> {
    await FlyService.updateMachineImage(machineId);
  }

  async deleteMachine(machineId: string): Promise<void> {
    await FlyService.deleteMachine(machineId);
  }

  // ---- Volume management ----

  async createVolume(name: string, region: string, sizeGb?: number): Promise<VolumeInfo> {
    const vol = await FlyService.createVolume(name, region, sizeGb);
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async getVolume(volumeId: string): Promise<VolumeInfo | null> {
    const vol = await FlyService.getVolume(volumeId);
    if (!vol) return null;
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async extendVolume(volumeId: string, newSizeGb: number): Promise<void> {
    await FlyService.extendVolume(volumeId, newSizeGb);
  }

  async forkVolume(sourceVolumeId: string, name: string, region: string, sizeGb?: number): Promise<VolumeInfo> {
    const vol = await FlyService.forkVolume(sourceVolumeId, name, region, sizeGb);
    return { id: vol.id, name: vol.name, state: vol.state, sizeGb: vol.size_gb, region: vol.region };
  }

  async createSnapshot(volumeId: string): Promise<SnapshotInfo> {
    return FlyService.createSnapshot(volumeId);
  }

  async deleteVolume(volumeId: string): Promise<void> {
    await FlyService.deleteVolume(volumeId);
  }

  // ---- Health / waiting ----

  async waitForState(machineId: string, targetStates: MachineState[], timeoutMs?: number): Promise<void> {
    // Expand normalized states into Fly states
    const flyStates = targetStates.flatMap(machineStateToFlyStates);
    await FlyService.waitForMachine(machineId, flyStates, timeoutMs);
  }

  async waitForHealthy(machineId: string, timeoutMs?: number): Promise<void> {
    await FlyService.waitForMachineHealthy(machineId, timeoutMs);
  }

  // ---- Routing ----

  getRoutingInfo(machineId: string): RoutingInfo {
    const serverUrl = `https://${FlyService.getServerAppNamePublic()}.fly.dev`;
    return {
      serverUrl,
      routingToken: machineId,
      requiresRoutingHeaders: true,
    };
  }

  // ---- Machine config updates ----

  async updateAutoSuspendPolicy(machineId: string, autoSuspendEnabled: boolean): Promise<void> {
    await FlyService.updateMachineAutoSuspend(machineId, autoSuspendEnabled);
  }

  async updateMachineEnv(machineId: string, env: Record<string, string>): Promise<void> {
    // Use ensureMachineTunnelToken for TUNNEL_TOKEN, or updateMachineConfig for generic env
    if (env.TUNNEL_TOKEN) {
      await FlyService.ensureMachineTunnelToken(machineId, env.TUNNEL_TOKEN);
    }
  }

  // ---- Fleet ----

  async listMachines(): Promise<MachineInfo[]> {
    const machines = await FlyService.listMachines();
    return machines.map(mapFlyMachine);
  }
}
