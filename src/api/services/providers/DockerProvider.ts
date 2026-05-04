/**
 * DockerProvider
 *
 * Implements IProvider for local development. Workspaces are provisioned as
 * Docker containers on the host's Docker daemon, with bind-mounted volumes
 * under /app/data/local-workspaces/<volumeId>/.
 *
 * See docs/superpowers/specs/2026-05-04-docker-provider-local-workspaces-design.md.
 */

import Docker from 'dockerode';
import { statSync } from 'node:fs';
import type { IProvider } from './IProvider';
import type {
  CreateMachineOptions,
  MachineInfo,
  MachineState,
  ProviderId,
  ProvisionResult,
  Region,
  RoutingInfo,
  SnapshotInfo,
  TierSpec,
  VolumeInfo,
} from './types';

const NOT_IMPLEMENTED = (method: string) =>
  new Error(`DockerProvider.${method} not implemented yet`);

const DEFAULT_DOCKER_SOCK = '/var/run/docker.sock';

export class DockerProvider implements IProvider {
  readonly id: ProviderId = 'docker';

  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  // Sync per IProvider contract. Checks that the Docker socket file exists
  // and (in production) is a Unix socket. The actual liveness check
  // (docker.ping()) happens lazily inside createMachine.
  isConfigured(): boolean {
    const sockPath = process.env.RUNHQ_DOCKER_SOCK_PATH || DEFAULT_DOCKER_SOCK;
    try {
      const s = statSync(sockPath);
      // Test-only env var lets unit tests use a regular file as a stand-in.
      if (process.env.RUNHQ_DOCKER_SOCK_KIND === 'file') return s.isFile();
      return s.isSocket();
    } catch {
      return false;
    }
  }

  getRegions(): Region[] {
    return [
      { id: 'local', providerId: 'docker', providerRegion: 'local', displayName: 'Local Docker' },
    ];
  }

  getTierSpecs(): TierSpec[] {
    return [
      { tierId: 'shared-4x-1gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 1024,  diskGb: 12,  label: 'Shared 4x / 1 GB' },
      { tierId: 'shared-4x-2gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 2048,  diskGb: 20,  label: 'Shared 4x / 2 GB' },
      { tierId: 'shared-4x-4gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 4096,  diskGb: 40,  label: 'Shared 4x / 4 GB' },
      { tierId: 'shared-4x-8gb',  cpuKind: 'shared',      cpus: 4, memoryMb: 8192,  diskGb: 40,  label: 'Shared 4x / 8 GB' },
      { tierId: 'shared-8x-4gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 4096,  diskGb: 40,  label: 'Shared 8x / 4 GB' },
      { tierId: 'shared-8x-8gb',  cpuKind: 'shared',      cpus: 8, memoryMb: 8192,  diskGb: 60,  label: 'Shared 8x / 8 GB' },
      { tierId: 'shared-8x-16gb', cpuKind: 'shared',      cpus: 8, memoryMb: 16384, diskGb: 80,  label: 'Shared 8x / 16 GB' },
      { tierId: 'perf-2x-4gb',    cpuKind: 'performance', cpus: 2, memoryMb: 4096,  diskGb: 40,  label: 'Perf 2x / 4 GB' },
      { tierId: 'perf-2x-8gb',    cpuKind: 'performance', cpus: 2, memoryMb: 8192,  diskGb: 60,  label: 'Perf 2x / 8 GB' },
      { tierId: 'perf-2x-16gb',   cpuKind: 'performance', cpus: 2, memoryMb: 16384, diskGb: 80,  label: 'Perf 2x / 16 GB' },
      { tierId: 'perf-4x-8gb',    cpuKind: 'performance', cpus: 4, memoryMb: 8192,  diskGb: 60,  label: 'Perf 4x / 8 GB' },
      { tierId: 'perf-4x-16gb',   cpuKind: 'performance', cpus: 4, memoryMb: 16384, diskGb: 100, label: 'Perf 4x / 16 GB' },
      { tierId: 'perf-4x-32gb',   cpuKind: 'performance', cpus: 4, memoryMb: 32768, diskGb: 160, label: 'Perf 4x / 32 GB' },
    ];
  }

  // -------------------------------------------------------------------------
  // App lifecycle (no-ops; Docker has no per-tenant network isolation locally)
  // -------------------------------------------------------------------------

  async createApp(_appName: string, _networkName: string): Promise<void> {}
  async deleteApp(_appName: string): Promise<void> {}
  async allocateIPs(_appName: string, _opts?: { sharedV4?: boolean; v6?: boolean }): Promise<void> {}
  async addCertificate(_appName: string, _hostname: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Machine lifecycle — STUBS (filled in subsequent tasks)
  // -------------------------------------------------------------------------

  async createMachine(_options: CreateMachineOptions): Promise<ProvisionResult> {
    throw NOT_IMPLEMENTED('createMachine');
  }
  async getMachineState(_machineId: string, _appName?: string | null): Promise<MachineState> {
    throw NOT_IMPLEMENTED('getMachineState');
  }
  async getMachineInfo(_machineId: string, _appName?: string | null): Promise<MachineInfo> {
    throw NOT_IMPLEMENTED('getMachineInfo');
  }
  async startMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('startMachine');
  }
  async stopMachine(
    _machineId: string,
    _appName?: string | null,
    _options?: { disableAutostart?: boolean },
  ): Promise<void> {
    throw NOT_IMPLEMENTED('stopMachine');
  }
  async suspendMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('suspendMachine');
  }
  async restartMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('restartMachine');
  }
  async updateMachineImage(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateMachineImage');
  }
  async deleteMachine(_machineId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('deleteMachine');
  }

  // -------------------------------------------------------------------------
  // Volumes — STUBS
  // -------------------------------------------------------------------------

  async createVolume(_name: string, _region: string, _sizeGb?: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('createVolume');
  }
  async getVolume(_volumeId: string, _appName?: string | null): Promise<VolumeInfo | null> {
    throw NOT_IMPLEMENTED('getVolume');
  }
  async extendVolume(_volumeId: string, _newSizeGb: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('extendVolume');
  }
  async createVolumeFromSnapshot(_snapshotId: string, _name: string, _region: string, _sizeGb: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('createVolumeFromSnapshot');
  }
  async forkVolume(_sourceVolumeId: string, _name: string, _region: string, _sizeGb?: number, _appName?: string | null): Promise<VolumeInfo> {
    throw NOT_IMPLEMENTED('forkVolume');
  }
  async createSnapshot(_volumeId: string, _appName?: string | null): Promise<SnapshotInfo> {
    throw NOT_IMPLEMENTED('createSnapshot');
  }
  async deleteVolume(_volumeId: string, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('deleteVolume');
  }
  async waitForVolumeReady(_volumeId: string, _appName?: string | null, _timeoutMs?: number): Promise<void> {
    throw NOT_IMPLEMENTED('waitForVolumeReady');
  }

  // -------------------------------------------------------------------------
  // Health / waiting / routing / config — STUBS
  // -------------------------------------------------------------------------

  async waitForState(_machineId: string, _targetStates: MachineState[], _timeoutMs?: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('waitForState');
  }
  async waitForHealthy(_machineId: string, _timeoutMs?: number, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('waitForHealthy');
  }
  getRoutingInfo(_machineId: string, _appName?: string | null): RoutingInfo {
    throw NOT_IMPLEMENTED('getRoutingInfo');
  }
  async updateAutoSuspendPolicy(_machineId: string, _autoSuspendEnabled: boolean, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateAutoSuspendPolicy');
  }
  async updateMachineEnv(_machineId: string, _env: Record<string, string>, _appName?: string | null): Promise<void> {
    throw NOT_IMPLEMENTED('updateMachineEnv');
  }
  async listMachines(_appName?: string | null): Promise<MachineInfo[]> {
    throw NOT_IMPLEMENTED('listMachines');
  }
}
