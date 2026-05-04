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

  resolveImageRef(): string {
    return process.env.RUNHQ_WORKSPACE_IMAGE || 'runhq-server:local';
  }

  private dockerfileDir(): string {
    return (
      process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR ||
      join(process.cwd(), '..', 'runhq', 'server')
    );
  }

  async ensureImage(ref: string): Promise<void> {
    const images = await this.docker.listImages({ filters: { reference: [ref] } });
    if (images.length > 0) return;

    if (!ref.endsWith(':local')) {
      throw new Error(
        `Workspace image '${ref}' not found locally. Pull it (e.g. \`docker pull ${ref}\`) or unset RUNHQ_WORKSPACE_IMAGE to lazy-build runhq-server:local.`,
      );
    }

    const ctxDir = this.dockerfileDir();
    console.log(`[DockerProvider] Building ${ref} from ${ctxDir} (one-time, may take minutes)...`);
    const stream = await this.docker.buildImage(
      { context: ctxDir, src: ['Dockerfile'] },
      { t: ref },
    );

    await new Promise<void>((resolve, reject) => {
      let lastError: Error | null = null;
      stream.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.error) lastError = new Error(`docker build: ${obj.error}`);
          } catch {
            // Non-JSON progress line; ignore.
          }
        }
      });
      stream.on('end', () => (lastError ? reject(lastError) : resolve()));
      stream.on('error', reject);
    });

    console.log(`[DockerProvider] Built ${ref}`);
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

  async createMachine(options: CreateMachineOptions): Promise<ProvisionResult> {
    // Liveness check: isConfigured() only verifies the socket file. Ping the
    // daemon to make sure it's actually responding before we commit to a flow.
    try {
      await this.docker.ping();
    } catch (err: unknown) {
      throw new Error(
        `Docker is not running. Start Docker before creating workspaces. (cause: ${(err as Error).message})`,
      );
    }

    const imageRef = this.resolveImageRef();
    await this.ensureImage(imageRef);

    const hostPort = await allocateHostPort();
    const volumeId = options.existingVolumeId ?? randomUUID();
    if (!options.existingVolumeId) {
      await mkdir(this.volumeDir(volumeId), { recursive: true, mode: 0o755 });
    }

    const tierSpec = this.getTierSpecs().find((t) => t.tierId === options.tier);
    if (!tierSpec) throw new Error(`Unknown tier: ${options.tier}`);

    const env = [
      `SERVER_TOKEN=${options.serverToken}`,
      `CLOUD_API_URL=${process.env.CLOUD_API_URL ?? ''}`,
      `PORT=61987`,
      `NODE_ENV=production`,
    ];
    if (options.tunnelToken) env.push(`TUNNEL_TOKEN=${options.tunnelToken}`);

    const labels: Record<string, string> = {
      'runhq.managed': 'true',
      'runhq.serverId': options.serverId,
      'runhq.volumeId': volumeId,
      'runhq.tier': options.tier,
      'runhq.hostPort': String(hostPort),
    };

    const container = await this.docker.createContainer({
      Image: imageRef,
      Env: env,
      Labels: labels,
      ExposedPorts: { '61987/tcp': {} },
      HostConfig: {
        Binds: [`${this.volumeDir(volumeId)}:/app/data`],
        PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
        NanoCpus: tierSpec.cpus * 1_000_000_000,
        Memory: tierSpec.memoryMb * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    } as Docker.ContainerCreateOptions);

    await container.start();

    const fullId = container.id;
    const machineId = fullId.slice(0, 12);

    return {
      machineId,
      machineName: machineId,
      serverUrl: `http://localhost:${hostPort}`,
      region: 'local',
      volumeId,
      // Persisted in servers.flyAppName so getRoutingInfo can reconstruct
      // the URL synchronously after a be restart (no Docker round-trip).
      appName: String(hostPort),
      networkName: null,
      providerMetadata: { hostPort, fullContainerId: fullId },
    };
  }
  async getMachineState(machineId: string, _appName?: string | null): Promise<MachineState> {
    try {
      const data = await this.docker.getContainer(machineId).inspect();
      return mapDockerState(data.State.Status);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) return 'destroyed';
      throw err;
    }
  }

  async getMachineInfo(machineId: string, _appName?: string | null): Promise<MachineInfo> {
    const data = await this.docker.getContainer(machineId).inspect();
    return {
      id: data.Id.slice(0, 12),
      name: typeof data.Name === 'string' ? data.Name.replace(/^\//, '') : data.Id.slice(0, 12),
      state: mapDockerState(data.State.Status),
      region: 'local',
    };
  }
  private isHttpError(err: unknown, code: number): boolean {
    return (err as { statusCode?: number })?.statusCode === code;
  }

  async startMachine(machineId: string, _appName?: string | null): Promise<void> {
    try {
      await this.docker.getContainer(machineId).start();
    } catch (err: unknown) {
      if (this.isHttpError(err, 304)) return;
      throw err;
    }
  }

  async stopMachine(
    machineId: string,
    _appName?: string | null,
    _options?: { disableAutostart?: boolean },
  ): Promise<void> {
    try {
      await this.docker.getContainer(machineId).stop({ t: 10 });
    } catch (err: unknown) {
      if (this.isHttpError(err, 304)) return;
      throw err;
    }
  }

  async restartMachine(machineId: string, _appName?: string | null): Promise<void> {
    await this.docker.getContainer(machineId).restart();
  }

  async suspendMachine(machineId: string, _appName?: string | null): Promise<void> {
    await this.docker.getContainer(machineId).pause();
  }

  private async recreateContainer(
    machineId: string,
    transform: (currentEnv: string[], currentImage: string) => { env: string[]; image: string },
  ): Promise<void> {
    const container = this.docker.getContainer(machineId);
    const data = await container.inspect();
    const labels = data.Config.Labels ?? {};
    const binds = data.HostConfig.Binds ?? [];
    const portBindings = data.HostConfig.PortBindings ?? {};
    const exposedPorts = data.Config.ExposedPorts ?? {};
    const nanoCpus = data.HostConfig.NanoCpus;
    const memory = data.HostConfig.Memory;
    const restartPolicy = data.HostConfig.RestartPolicy;
    const currentEnv = data.Config.Env ?? [];
    const currentImage = data.Config.Image;

    const { env: newEnv, image: newImage } = transform(currentEnv, currentImage);

    await container.stop({ t: 10 }).catch((err: unknown) => {
      if (!this.isHttpError(err, 304) && !this.isHttpError(err, 404)) throw err;
    });
    await container.remove().catch((err: unknown) => {
      if (!this.isHttpError(err, 404)) throw err;
    });

    await this.ensureImage(newImage);
    const fresh = await this.docker.createContainer({
      Image: newImage,
      Env: newEnv,
      Labels: labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: binds,
        PortBindings: portBindings,
        NanoCpus: nanoCpus,
        Memory: memory,
        RestartPolicy: restartPolicy,
      },
    } as Docker.ContainerCreateOptions);
    await fresh.start();
  }

  async updateMachineImage(machineId: string, _appName?: string | null): Promise<void> {
    const newImage = this.resolveImageRef();
    await this.recreateContainer(machineId, (env) => ({ env, image: newImage }));
  }

  async deleteMachine(machineId: string, _appName?: string | null): Promise<void> {
    const container = this.docker.getContainer(machineId);
    try {
      await container.stop({ t: 10 });
    } catch (err: unknown) {
      if (!this.isHttpError(err, 304) && !this.isHttpError(err, 404)) throw err;
    }
    try {
      await container.remove();
    } catch (err: unknown) {
      if (!this.isHttpError(err, 404)) throw err;
    }
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

  async createVolumeFromSnapshot(
    _snapshotId: string,
    _name: string,
    _region: string,
    _sizeGb: number,
    _appName?: string | null,
  ): Promise<VolumeInfo> {
    throw new Error(
      'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
  }

  async forkVolume(
    _sourceVolumeId: string,
    _name: string,
    _region: string,
    _sizeGb?: number,
    _appName?: string | null,
  ): Promise<VolumeInfo> {
    throw new Error(
      'Volume forking is not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
  }

  async createSnapshot(_volumeId: string, _appName?: string | null): Promise<SnapshotInfo> {
    throw new Error(
      'Snapshots are not supported by DockerProvider. Set LOCAL_PROVIDER=fly to test that flow against a real Fly account.',
    );
  }

  // -------------------------------------------------------------------------
  // Health / waiting / routing / config — STUBS
  // -------------------------------------------------------------------------

  async waitForState(
    machineId: string,
    targetStates: MachineState[],
    timeoutMs: number = 60_000,
    _appName?: string | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState: MachineState | 'unknown' = 'unknown';

    while (Date.now() < deadline) {
      try {
        const data = await this.docker.getContainer(machineId).inspect();
        lastState = mapDockerState(data.State.Status);
        if (targetStates.includes(lastState as MachineState)) return;
      } catch (err: unknown) {
        if (this.isHttpError(err, 404)) lastState = 'destroyed';
        else throw err;
        if (targetStates.includes('destroyed')) return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(
      `waitForState timed out after ${timeoutMs}ms (last state: ${lastState}, targets: ${targetStates.join(',')})`,
    );
  }

  async waitForHealthy(
    machineId: string,
    timeoutMs: number = 60_000,
    _appName?: string | null,
  ): Promise<void> {
    const data = await this.docker.getContainer(machineId).inspect();
    const port = data.Config?.Labels?.['runhq.hostPort'];
    if (!port) {
      throw new Error(`waitForHealthy: container ${machineId} has no runhq.hostPort label`);
    }
    const url = `http://localhost:${port}/health`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 2_000);
      try {
        const res = await fetch(url, { signal: ac.signal });
        clearTimeout(timer);
        if (res.ok) return;
      } catch {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(`waitForHealthy timed out after ${timeoutMs}ms (url: ${url})`);
  }
  getRoutingInfo(_machineId: string, appName?: string | null): RoutingInfo {
    const port = appName?.trim();
    if (!port) {
      throw new Error(
        'DockerProvider.getRoutingInfo: missing appName (expected host port string in servers.flyAppName)',
      );
    }
    return {
      serverUrl: `http://localhost:${port}`,
      routingToken: null,
      requiresRoutingHeaders: false,
    };
  }

  async updateAutoSuspendPolicy(
    _machineId: string,
    _autoSuspendEnabled: boolean,
    _appName?: string | null,
  ): Promise<void> {
    // Auto-suspend is a Fly cost optimization that doesn't apply locally.
  }
  async updateMachineEnv(
    machineId: string,
    envUpdates: Record<string, string>,
    _appName?: string | null,
  ): Promise<void> {
    await this.recreateContainer(machineId, (currentEnv, currentImage) => {
      const map = new Map<string, string>();
      for (const line of currentEnv) {
        const eq = line.indexOf('=');
        if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
      }
      for (const [k, v] of Object.entries(envUpdates)) map.set(k, v);
      const env = [...map.entries()].map(([k, v]) => `${k}=${v}`);
      return { env, image: currentImage };
    });
  }
  async listMachines(_appName?: string | null): Promise<MachineInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['runhq.managed=true'] },
    });
    return containers.map((c) => {
      const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
      return {
        id: c.Id.slice(0, 12),
        name,
        state: mapDockerState(c.State as string),
        region: 'local',
      };
    });
  }
}
