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
import { statSync, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

function mapDockerState(dockerStatus: string): MachineState {
  switch (dockerStatus) {
    case 'running':    return 'running';
    case 'paused':     return 'suspended';
    case 'exited':     return 'stopped';
    case 'created':    return 'stopped';
    case 'restarting': return 'starting';
    case 'removing':   return 'destroying';
    case 'dead':       return 'destroyed';
    default:
      throw new Error(`Unknown docker state: ${dockerStatus}`);
  }
}

async function allocateHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('Failed to allocate host port'));
      }
    });
  });
}

// Test-only export. Do not import from production code.
export const __test__ = { mapDockerState, allocateHostPort };

export class DockerProvider implements IProvider {
  readonly id: ProviderId = 'docker';

  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  private get volumesBaseDir(): string {
    return process.env.RUNHQ_LOCAL_VOLUMES_DIR || '/app/data/local-workspaces';
  }

  private volumeDir(volumeId: string): string {
    return join(this.volumesBaseDir, volumeId);
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

  async createVolume(
    name: string,
    region: string,
    sizeGb?: number,
    _appName?: string | null,
  ): Promise<VolumeInfo> {
    const id = randomUUID();
    await mkdir(this.volumeDir(id), { recursive: true, mode: 0o755 });
    return {
      id,
      name,
      state: 'created',
      sizeGb: sizeGb ?? 0,
      region: region || 'local',
    };
  }

  async getVolume(volumeId: string, _appName?: string | null): Promise<VolumeInfo | null> {
    const dir = this.volumeDir(volumeId);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return null;
      return {
        id: volumeId,
        name: volumeId,
        state: 'created',
        sizeGb: 0,
        region: 'local',
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async extendVolume(_volumeId: string, _newSizeGb: number, _appName?: string | null): Promise<void> {
    // Local provider does not enforce volume size; host fs has whatever space it has.
  }

  async deleteVolume(volumeId: string, _appName?: string | null): Promise<void> {
    if (!existsSync(this.volumeDir(volumeId))) return; // idempotent
    await rm(this.volumeDir(volumeId), { recursive: true, force: true });
  }

  async waitForVolumeReady(_volumeId: string, _appName?: string | null, _timeoutMs?: number): Promise<void> {
    // Host fs is always ready.
  }

  async createVolumeFromSnapshot(): Promise<VolumeInfo> {
    throw new Error(
      'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
  }

  async forkVolume(): Promise<VolumeInfo> {
    throw new Error(
      'Volume forking is not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
  }

  async createSnapshot(): Promise<SnapshotInfo> {
    throw new Error(
      'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
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
