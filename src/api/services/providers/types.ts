/**
 * Provider Abstraction — Shared Type Definitions
 *
 * Provider-agnostic types used by the provider interface, registry,
 * and all consumers (ServerService, HttpServer, etc.).
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type ProviderId = 'fly';

// ---------------------------------------------------------------------------
// Machine states (normalized across providers)
// ---------------------------------------------------------------------------

export type MachineState =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'suspended'
  | 'destroying'
  | 'destroyed';

// ---------------------------------------------------------------------------
// Tiers (provider-agnostic)
// ---------------------------------------------------------------------------

export type TierId =
  | 'shared-4x-1gb' | 'shared-4x-2gb' | 'shared-4x-4gb' | 'shared-4x-8gb'
  | 'shared-8x-4gb' | 'shared-8x-8gb' | 'shared-8x-16gb'
  | 'perf-2x-4gb' | 'perf-2x-8gb' | 'perf-2x-16gb'
  | 'perf-4x-8gb' | 'perf-4x-16gb' | 'perf-4x-32gb';

export interface TierSpec {
  tierId: TierId;
  cpuKind: 'shared' | 'performance';
  cpus: number;
  memoryMb: number;
  diskGb: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export interface Region {
  id: string;
  providerId: ProviderId;
  providerRegion: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Machine provisioning
// ---------------------------------------------------------------------------

export interface CreateMachineOptions {
  serverId: string;
  serverToken: string;
  tunnelToken?: string | null;
  region: string;
  tier: TierId;
  existingVolumeId?: string | null;
  autoSuspendEnabled?: boolean;
}

export interface ProvisionResult {
  machineId: string;
  machineName: string;
  serverUrl: string;
  region: string;
  volumeId: string;
  providerMetadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RoutingInfo {
  serverUrl: string;
  routingToken: string | null;
  requiresRoutingHeaders: boolean;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export interface VolumeInfo {
  id: string;
  name: string;
  state: string;
  sizeGb: number;
  region: string;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface SnapshotInfo {
  id: string;
}

// ---------------------------------------------------------------------------
// Machine info (returned by getMachineState / listMachines)
// ---------------------------------------------------------------------------

export interface MachineInfo {
  id: string;
  name: string;
  state: MachineState;
  region: string;
}
