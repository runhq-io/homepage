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
  // App / network lifecycle (per-tenant isolation)
  //
  // For Fly: each workspace is provisioned as its own Fly app on a dedicated
  // 6PN network so tenants cannot reach each other on Fly's private mesh.
  // See docs/per-app-isolation-migration.md.
  //
  // Implementations should be idempotent — safe to call repeatedly with the
  // same name (treats "already exists" as success on create, "already deleted"
  // as success on delete).
  // ---------------------------------------------------------------------------

  createApp(appName: string, networkName: string): Promise<void>;
  deleteApp(appName: string): Promise<void>;

  // Allocate public IP addresses on an app so its `<app>.fly.dev` (or
  // equivalent) hostname is reachable from the public internet. Per-tenant
  // apps need this in addition to a machine — `POST /v1/apps` does not
  // auto-allocate. Idempotent.
  allocateIPs(appName: string, opts?: { sharedV4?: boolean; v6?: boolean }): Promise<void>;

  // Issue a TLS certificate for `hostname` on an app (Fly: ACME via Fly's
  // edge proxy). Used so per-tenant workspaces can present a valid cert
  // for their `srv-<machineId>.<domain>` subdomain. Idempotent on
  // already-exists.
  addCertificate(appName: string, hostname: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Machine lifecycle
  //
  // The optional `appName` argument scopes the call to a per-tenant app. When
  // omitted (or null), legacy behavior applies: the call hits the shared app
  // configured via env. Callers from ServerService pass `server.flyAppName`.
  // ---------------------------------------------------------------------------

  createMachine(options: CreateMachineOptions): Promise<ProvisionResult>;
  getMachineState(machineId: string, appName?: string | null): Promise<MachineState>;
  getMachineInfo(machineId: string, appName?: string | null): Promise<MachineInfo>;
  startMachine(machineId: string, appName?: string | null): Promise<void>;
  stopMachine(machineId: string, appName?: string | null): Promise<void>;
  suspendMachine(machineId: string, appName?: string | null): Promise<void>;
  restartMachine(machineId: string, appName?: string | null): Promise<void>;
  updateMachineImage(machineId: string, appName?: string | null): Promise<void>;
  deleteMachine(machineId: string, appName?: string | null): Promise<void>;

  // ---------------------------------------------------------------------------
  // Volume management
  // ---------------------------------------------------------------------------

  createVolume(name: string, region: string, sizeGb?: number, appName?: string | null): Promise<VolumeInfo>;
  getVolume(volumeId: string, appName?: string | null): Promise<VolumeInfo | null>;
  extendVolume(volumeId: string, newSizeGb: number, appName?: string | null): Promise<void>;
  createVolumeFromSnapshot(snapshotId: string, name: string, region: string, sizeGb: number, appName?: string | null): Promise<VolumeInfo>;
  forkVolume(sourceVolumeId: string, name: string, region: string, sizeGb?: number, appName?: string | null): Promise<VolumeInfo>;
  createSnapshot(volumeId: string, appName?: string | null): Promise<SnapshotInfo>;
  deleteVolume(volumeId: string, appName?: string | null): Promise<void>;

  // ---------------------------------------------------------------------------
  // Health / waiting
  // ---------------------------------------------------------------------------

  waitForState(machineId: string, targetStates: MachineState[], timeoutMs?: number, appName?: string | null): Promise<void>;
  waitForHealthy(machineId: string, timeoutMs?: number, appName?: string | null): Promise<void>;

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  getRoutingInfo(machineId: string, appName?: string | null): RoutingInfo;

  // ---------------------------------------------------------------------------
  // Machine config updates
  // ---------------------------------------------------------------------------

  updateAutoSuspendPolicy(machineId: string, autoSuspendEnabled: boolean, appName?: string | null): Promise<void>;
  updateMachineEnv(machineId: string, env: Record<string, string>, appName?: string | null): Promise<void>;

  // ---------------------------------------------------------------------------
  // Fleet
  //
  // Note: under per-tenant apps, `listMachines()` only returns machines from
  // the legacy shared app. To iterate the fleet, drive off the `servers` table
  // (which holds per-row `flyAppName`) and call `getMachineInfo` per server.
  // ---------------------------------------------------------------------------

  listMachines(appName?: string | null): Promise<MachineInfo[]>;
}
