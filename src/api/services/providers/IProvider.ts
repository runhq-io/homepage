/**
 * Provider Interface
 *
 * Every infrastructure provider (Fly.io) implements this interface.
 * ServerService calls through IProvider — it never touches provider-specific APIs directly.
 */

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

export interface IProvider {
  readonly id: ProviderId;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  isConfigured(): boolean;
  getRegions(): Region[];
  getTierSpecs(): TierSpec[];

  // ---------------------------------------------------------------------------
  // Machine lifecycle
  // ---------------------------------------------------------------------------

  createMachine(options: CreateMachineOptions): Promise<ProvisionResult>;
  getMachineState(machineId: string): Promise<MachineState>;
  getMachineInfo(machineId: string): Promise<MachineInfo>;
  startMachine(machineId: string): Promise<void>;
  stopMachine(machineId: string): Promise<void>;
  suspendMachine(machineId: string): Promise<void>;
  restartMachine(machineId: string): Promise<void>;
  updateMachineImage(machineId: string): Promise<void>;
  deleteMachine(machineId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Volume management
  // ---------------------------------------------------------------------------

  createVolume(name: string, region: string, sizeGb?: number): Promise<VolumeInfo>;
  getVolume(volumeId: string): Promise<VolumeInfo | null>;
  extendVolume(volumeId: string, newSizeGb: number): Promise<void>;
  createVolumeFromSnapshot(snapshotId: string, name: string, region: string, sizeGb: number): Promise<VolumeInfo>;
  forkVolume(sourceVolumeId: string, name: string, region: string, sizeGb?: number): Promise<VolumeInfo>;
  createSnapshot(volumeId: string): Promise<SnapshotInfo>;
  deleteVolume(volumeId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Health / waiting
  // ---------------------------------------------------------------------------

  waitForState(machineId: string, targetStates: MachineState[], timeoutMs?: number): Promise<void>;
  waitForHealthy(machineId: string, timeoutMs?: number): Promise<void>;

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  getRoutingInfo(machineId: string): RoutingInfo;

  // ---------------------------------------------------------------------------
  // Machine config updates
  // ---------------------------------------------------------------------------

  updateAutoSuspendPolicy(machineId: string, autoSuspendEnabled: boolean): Promise<void>;
  updateMachineEnv(machineId: string, env: Record<string, string>): Promise<void>;

  // ---------------------------------------------------------------------------
  // Fleet
  // ---------------------------------------------------------------------------

  listMachines(): Promise<MachineInfo[]>;
}
