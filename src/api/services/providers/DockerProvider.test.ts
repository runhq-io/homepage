import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineState } from './types';

// Mock dockerode at the module level. Each test resets the mock and configures
// behaviour via the returned mock factory.
const mockPing = vi.fn();
const mockListContainers = vi.fn();
const mockListImages = vi.fn();
const mockGetContainer = vi.fn();
const mockBuildImage = vi.fn();
const mockCreateContainer = vi.fn();

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: mockPing,
      listContainers: mockListContainers,
      listImages: mockListImages,
      getContainer: mockGetContainer,
      buildImage: mockBuildImage,
      createContainer: mockCreateContainer,
    })),
  };
});

// For isConfigured() tests we point RUNHQ_DOCKER_SOCK_PATH at a fake socket file
// (or a non-existent path) so we can deterministically test the sync check
// without needing a real Docker daemon.
function makeFakeSocket(dir: string): string {
  // Node has no API to create a Unix socket file inode without binding a server,
  // so we use an empty regular file and set RUNHQ_DOCKER_SOCK_KIND=file in tests
  // to bypass the isSocket() assertion. Production code does NOT honor this env
  // var (test-only; declared in the test file).
  const path = join(dir, 'docker.sock');
  writeFileSync(path, '');
  return path;
}

describe('DockerProvider — configuration', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let tmp: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tmp = mkdtempSync(join(tmpdir(), 'runhq-cfg-'));
    delete process.env.RUNHQ_DOCKER_SOCK_PATH;
    delete process.env.RUNHQ_DOCKER_SOCK_KIND;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.RUNHQ_DOCKER_SOCK_PATH;
    delete process.env.RUNHQ_DOCKER_SOCK_KIND;
  });

  it('exposes id "docker"', () => {
    const p = new DockerProvider();
    expect(p.id).toBe('docker');
  });

  it('isConfigured() returns true when socket file exists (sync check)', () => {
    process.env.RUNHQ_DOCKER_SOCK_PATH = makeFakeSocket(tmp);
    process.env.RUNHQ_DOCKER_SOCK_KIND = 'file';
    const p = new DockerProvider();
    expect(p.isConfigured()).toBe(true);
  });

  it('isConfigured() returns false when socket path does not exist', () => {
    process.env.RUNHQ_DOCKER_SOCK_PATH = join(tmp, 'nope.sock');
    const p = new DockerProvider();
    expect(p.isConfigured()).toBe(false);
  });

  it('getRegions() returns a single synthetic local region', () => {
    const p = new DockerProvider();
    expect(p.getRegions()).toEqual([
      { id: 'local', providerId: 'docker', providerRegion: 'local', displayName: 'Local Docker' },
    ]);
  });

  it('getTierSpecs() returns the same 13 tier specs as Fly', () => {
    const p = new DockerProvider();
    const specs = p.getTierSpecs();
    expect(specs).toHaveLength(13);
    expect(specs.map((s) => s.tierId)).toContain('shared-4x-2gb');
    expect(specs.map((s) => s.tierId)).toContain('perf-4x-32gb');
  });
});

describe('DockerProvider — volumes', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let baseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-vol-test-'));
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
  });

  it('createVolume mkdir\'s a UUID-named dir under the base and returns VolumeInfo', async () => {
    const p = new DockerProvider();
    const info = await p.createVolume('my-vol', 'local', 10);
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(info.name).toBe('my-vol');
    expect(info.state).toBe('created');
    expect(info.sizeGb).toBe(10);
    expect(info.region).toBe('local');
    expect(existsSync(join(baseDir, info.id))).toBe(true);
    expect(statSync(join(baseDir, info.id)).isDirectory()).toBe(true);
  });

  it('getVolume returns info for an existing dir', async () => {
    const p = new DockerProvider();
    const created = await p.createVolume('v', 'local', 5);
    const fetched = await p.getVolume(created.id);
    expect(fetched).toEqual({
      id: created.id,
      name: created.id,
      state: 'created',
      sizeGb: 0,
      region: 'local',
    });
  });

  it('getVolume returns null for a non-existent dir', async () => {
    const p = new DockerProvider();
    expect(await p.getVolume('does-not-exist')).toBeNull();
  });

  it('deleteVolume removes the dir', async () => {
    const p = new DockerProvider();
    const v = await p.createVolume('v', 'local', 1);
    expect(existsSync(join(baseDir, v.id))).toBe(true);
    await p.deleteVolume(v.id);
    expect(existsSync(join(baseDir, v.id))).toBe(false);
  });

  it('deleteVolume is idempotent (no-op on missing dir)', async () => {
    const p = new DockerProvider();
    await expect(p.deleteVolume('never-existed')).resolves.toBeUndefined();
  });

  it('extendVolume is a no-op (does not throw)', async () => {
    const p = new DockerProvider();
    const v = await p.createVolume('v', 'local', 1);
    await expect(p.extendVolume(v.id, 100)).resolves.toBeUndefined();
  });

  it('waitForVolumeReady resolves immediately', async () => {
    const p = new DockerProvider();
    await expect(p.waitForVolumeReady('any-id')).resolves.toBeUndefined();
  });

  it('createVolumeFromSnapshot throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.createVolumeFromSnapshot('s', 'n', 'local', 1)).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });

  it('forkVolume throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.forkVolume('v', 'n', 'local')).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });

  it('createSnapshot throws not-supported', async () => {
    const p = new DockerProvider();
    await expect(p.createSnapshot('v')).rejects.toThrow(
      /not supported by DockerProvider/,
    );
  });
});

describe('DockerProvider — state mapping', () => {
  let mapDockerState: (s: string) => MachineState;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./DockerProvider');
    mapDockerState = mod.__test__.mapDockerState;
  });

  it.each([
    ['running', 'running'],
    ['paused', 'suspended'],
    ['exited', 'stopped'],
    ['created', 'stopped'],
    ['restarting', 'starting'],
    ['removing', 'destroying'],
    ['dead', 'destroyed'],
  ] as const)('maps docker state %s -> %s', (docker, expected) => {
    expect(mapDockerState(docker)).toBe(expected);
  });

  it('throws on unknown docker state', () => {
    expect(() => mapDockerState('cosmic-ray')).toThrow(/unknown docker state/i);
  });
});

describe('DockerProvider — port allocation', () => {
  let allocateHostPort: () => Promise<number>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./DockerProvider');
    allocateHostPort = mod.__test__.allocateHostPort;
  });

  it('returns a free port (> 1024)', async () => {
    const port = await allocateHostPort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it('returns different ports across calls', async () => {
    const a = await allocateHostPort();
    const b = await allocateHostPort();
    expect(a).not.toBe(b);
  });
});

describe('DockerProvider — clampTierToHost', () => {
  let clampTierToHost: (cpus: number, memMb: number, host: { cpus: number; memoryMb: number }) =>
    { cpus: number; memoryMb: number };

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./DockerProvider');
    clampTierToHost = mod.__test__.clampTierToHost;
  });

  it('passes a request through unchanged when the host can fit it', () => {
    expect(clampTierToHost(2, 4096, { cpus: 8, memoryMb: 16_384 })).toEqual({
      cpus: 2,
      memoryMb: 4096,
    });
  });

  it('clamps CPUs to host cores when the request exceeds them', () => {
    expect(clampTierToHost(8, 1024, { cpus: 2, memoryMb: 16_384 })).toEqual({
      cpus: 2,
      memoryMb: 1024,
    });
  });

  it('clamps memory to host RAM minus a 512 MB reserve', () => {
    expect(clampTierToHost(2, 32_768, { cpus: 4, memoryMb: 8192 })).toEqual({
      cpus: 2,
      memoryMb: 8192 - 512,
    });
  });

  it('never returns < 1 cpu even if the host reports 0', () => {
    // Pathological host (shouldn't happen in practice) — guard against /0 etc.
    expect(clampTierToHost(4, 4096, { cpus: 0, memoryMb: 4096 }).cpus).toBe(1);
  });

  it('never returns less than 256 MB of memory even if reserve eats everything', () => {
    expect(clampTierToHost(2, 4096, { cpus: 2, memoryMb: 256 }).memoryMb).toBeGreaterThanOrEqual(256);
  });
});

describe('DockerProvider — container CLOUD_API_URL', () => {
  let resolveContainerCloudApiUrl: (host: string | undefined) => string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.RUNHQ_WORKSPACE_CLOUD_API_URL;
    delete process.env.PORT;
    const mod = await import('./DockerProvider');
    resolveContainerCloudApiUrl = mod.__test__.resolveContainerCloudApiUrl;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('honours RUNHQ_WORKSPACE_CLOUD_API_URL override absolutely', () => {
    process.env.RUNHQ_WORKSPACE_CLOUD_API_URL = 'https://staging.example.com';
    // Host URL is ignored entirely when override is set.
    expect(resolveContainerCloudApiUrl('http://localhost:9000')).toBe(
      'https://staging.example.com',
    );
    expect(resolveContainerCloudApiUrl('https://console.runhq.io')).toBe(
      'https://staging.example.com',
    );
  });

  it('defaults to host.docker.internal:<PORT> regardless of host CLOUD_API_URL', () => {
    process.env.PORT = '9000';
    // The local be must be the cloud API for the container so the locally
    // issued SERVER_TOKEN is recognised. Host CLOUD_API_URL (localhost, prod,
    // anything) is intentionally ignored.
    expect(resolveContainerCloudApiUrl('http://localhost:9000')).toBe(
      'http://host.docker.internal:9000',
    );
    expect(resolveContainerCloudApiUrl('https://console.runhq.io')).toBe(
      'http://host.docker.internal:9000',
    );
    expect(resolveContainerCloudApiUrl(undefined)).toBe('http://host.docker.internal:9000');
    expect(resolveContainerCloudApiUrl('')).toBe('http://host.docker.internal:9000');
    expect(resolveContainerCloudApiUrl('not a url')).toBe('http://host.docker.internal:9000');
  });

  it('defaults to port 9000 when PORT is unset', () => {
    delete process.env.PORT;
    expect(resolveContainerCloudApiUrl('http://localhost:9000')).toBe(
      'http://host.docker.internal:9000',
    );
  });

  it('honours a custom PORT for the local be', () => {
    process.env.PORT = '8080';
    expect(resolveContainerCloudApiUrl('http://localhost:8080')).toBe(
      'http://host.docker.internal:8080',
    );
  });
});

describe('DockerProvider — image resolution', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('uses RUNHQ_WORKSPACE_IMAGE env var when set', () => {
    process.env.RUNHQ_WORKSPACE_IMAGE = 'my.registry/foo:v1';
    const p = new DockerProvider();
    expect(p.resolveImageRef()).toBe('my.registry/foo:v1');
  });

  it('defaults to runhq-server:local when env var unset', () => {
    const p = new DockerProvider();
    expect(p.resolveImageRef()).toBe('runhq-server:local');
  });

  it('ensureImage skips build when image already exists', async () => {
    mockListImages.mockResolvedValueOnce([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);
    const p = new DockerProvider();
    await p.ensureImage('runhq-server:local');
    expect(mockBuildImage).not.toHaveBeenCalled();
  });

  it('ensureImage builds when :local tag missing and dockerfile dir is set', async () => {
    process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR = '/tmp/fake-dockerfile-dir';
    mockListImages.mockResolvedValueOnce([]);

    const fakeStream = {
      on: vi.fn((evt: string, cb: () => void) => {
        if (evt === 'end') queueMicrotask(cb);
        return fakeStream;
      }),
    };
    mockBuildImage.mockResolvedValueOnce(fakeStream);

    const p = new DockerProvider();
    await p.ensureImage('runhq-server:local');

    expect(mockBuildImage).toHaveBeenCalledTimes(1);
    const [ctx, opts] = mockBuildImage.mock.calls[0];
    expect(ctx).toMatchObject({ context: '/tmp/fake-dockerfile-dir' });
    expect(opts).toMatchObject({ t: 'runhq-server:local' });
  });

  it('ensureImage throws when non-:local image is missing (no auto-build)', async () => {
    mockListImages.mockResolvedValueOnce([]);
    const p = new DockerProvider();
    await expect(p.ensureImage('my.registry/foo:v1')).rejects.toThrow(
      /image 'my.registry\/foo:v1' not found.*pull/i,
    );
    expect(mockBuildImage).not.toHaveBeenCalled();
  });
});

describe('DockerProvider — createMachine', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  let baseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-cm-test-'));
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
    delete process.env.RUNHQ_WORKSPACE_DOCKERFILE_DIR;
    delete process.env.RUNHQ_WORKSPACE_CLOUD_API_URL;
    delete process.env.RUNHQ_WORKSPACE_PUBLIC_URL_TEMPLATE;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.RUNHQ_MACHINE_ID;
    delete process.env.RUNHQ_PREVIEW_DOMAIN;
    delete process.env.PREVIEW_DOMAIN;
    delete process.env.CLIENT_URL;
    process.env.CLOUD_API_URL = 'http://test.cloud';
    process.env.SERVER_SESSION_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nTESTKEY\n-----END PUBLIC KEY-----';

    mockListImages.mockResolvedValue([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);

    const fullId = 'a'.repeat(64);
    const fakeContainer = {
      id: fullId,
      start: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateContainer.mockResolvedValue(fakeContainer);

    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
    delete process.env.CLOUD_API_URL;
    delete process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
    delete process.env.RUNHQ_WORKSPACE_CLOUD_API_URL;
    delete process.env.RUNHQ_WORKSPACE_PUBLIC_URL_TEMPLATE;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.RUNHQ_MACHINE_ID;
    delete process.env.RUNHQ_PREVIEW_DOMAIN;
    delete process.env.PREVIEW_DOMAIN;
    delete process.env.CLIENT_URL;
  });

  it('returns a ProvisionResult with localhost URL, 12-char machine id, and host port stored in appName', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    const result = await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'session-token',
      region: 'local',
      tier: 'shared-4x-2gb',
      existingVolumeId: v.id,
      autoSuspendEnabled: false,
      appName: null,
      networkName: null,
    });

    expect(result.machineId).toMatch(/^[a-f0-9]{12}$/);
    const portMatch = result.serverUrl.match(/^http:\/\/localhost:(\d+)$/);
    expect(portMatch).not.toBeNull();
    const hostPort = Number(portMatch![1]);
    expect(result.appName).toBe(String(hostPort));
    expect(result.region).toBe('local');
    expect(result.volumeId).toBe(v.id);
    expect(result.providerMetadata).toMatchObject({
      hostPort,
      fullContainerId: 'a'.repeat(64),
    });
  });

  it('passes correct container spec to dockerode.createContainer', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'session-token',
      region: 'local',
      tier: 'shared-4x-2gb',
      existingVolumeId: v.id,
      appName: null,
      networkName: null,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const spec = mockCreateContainer.mock.calls[0][0];

    expect(spec.Image).toBe('runhq-server:local');
    // Env block must match FlyService injection (minus Fly-only metadata).
    // The workspace image bakes AUTH_MODE=cloud, so SERVER_SESSION_PUBLIC_KEY_PEM
    // is mandatory or the runhq server crashes on boot.
    expect(spec.Env).toEqual(expect.arrayContaining([
      'SERVER_TOKEN=session-token',
      'SERVER_ID=srv-123',
      'SERVER_NAME=ws-srv-123',
      'AUTH_MODE=cloud',
      // Container's CLOUD_API_URL is always the local be (so locally-issued
      // tokens are recognised) — host's CLOUD_API_URL is intentionally
      // ignored. PORT defaults to 9000.
      'CLOUD_API_URL=http://host.docker.internal:9000',
      'SERVER_SESSION_PUBLIC_KEY_PEM=-----BEGIN PUBLIC KEY-----\nTESTKEY\n-----END PUBLIC KEY-----',
      'PREVIEW_DOMAIN=tank.fish',
      'CLIENT_URL=https://app.runhq.io',
      'NODE_ENV=development',
      'PORT=61987',
      'HOST=0.0.0.0',
      // SERVER_PUBLIC_URL pins the URL the container reports at registration —
      // must be the host loopback so the client-side SW can rewrite it for
      // remote browsers. Host port is allocated dynamically; assert via regex.
      expect.stringMatching(/^SERVER_PUBLIC_URL=http:\/\/localhost:\d+$/),
    ]));
    expect(spec.Labels).toMatchObject({
      'runhq.managed': 'true',
      'runhq.serverId': 'srv-123',
      'runhq.volumeId': v.id,
      'runhq.tier': 'shared-4x-2gb',
    });
    expect(spec.Labels['runhq.hostPort']).toMatch(/^\d+$/);
    expect(spec.HostConfig.Binds).toEqual([
      `${join(baseDir, v.id)}:/app/data`,
    ]);
    expect(spec.HostConfig.PortBindings['61987/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: expect.any(String) },
    ]);
    expect(spec.HostConfig.ExtraHosts).toEqual(['host.docker.internal:host-gateway']);
    // NanoCpus / Memory are clamped to host capacity at runtime — see
    // `clampTierToHost`. We assert "didn't exceed the requested tier" rather
    // than a fixed number so the test runs on machines of any size.
    expect(spec.HostConfig.NanoCpus).toBeGreaterThan(0);
    expect(spec.HostConfig.NanoCpus).toBeLessThanOrEqual(4_000_000_000);
    expect(spec.HostConfig.Memory).toBeGreaterThan(0);
    expect(spec.HostConfig.Memory).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' });
  });

  it('container.start() is called after create', async () => {
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);

    await p.createMachine({
      serverId: 'srv-123',
      serverToken: 'tok',
      region: 'local',
      tier: 'shared-4x-1gb',
      existingVolumeId: v.id,
    });

    const ret = await mockCreateContainer.mock.results[0].value;
    expect(ret.start).toHaveBeenCalledTimes(1);
  });

  it('throws when SERVER_SESSION_PUBLIC_KEY_PEM is not set on the backend', async () => {
    delete process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
    mockPing.mockResolvedValueOnce('OK');
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);
    await expect(
      p.createMachine({
        serverId: 'srv',
        serverToken: 'tok',
        region: 'local',
        tier: 'shared-4x-1gb',
        existingVolumeId: v.id,
      }),
    ).rejects.toThrow(/SERVER_SESSION_PUBLIC_KEY_PEM is not set/);
  });

  it('throws when docker.ping() rejects (daemon not responding)', async () => {
    mockPing.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const p = new DockerProvider();
    const v = await p.createVolume('vol', 'local', 10);
    await expect(
      p.createMachine({
        serverId: 'srv',
        serverToken: 'tok',
        region: 'local',
        tier: 'shared-4x-1gb',
        existingVolumeId: v.id,
      }),
    ).rejects.toThrow(/Docker is not running/);
  });
});

describe('DockerProvider — inspect', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();
  const containerStub = { inspect: mockInspect };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue(containerStub);
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('getMachineState returns mapped state', async () => {
    mockInspect.mockResolvedValueOnce({ State: { Status: 'running' } });
    const p = new DockerProvider();
    expect(await p.getMachineState('abc')).toBe('running');
    expect(mockGetContainer).toHaveBeenCalledWith('abc');
  });

  it('getMachineState returns "destroyed" on 404', async () => {
    const err = Object.assign(new Error('No such container'), { statusCode: 404 });
    mockInspect.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    expect(await p.getMachineState('gone')).toBe('destroyed');
  });

  it('getMachineState propagates non-404 errors', async () => {
    mockInspect.mockRejectedValueOnce(new Error('socket closed'));
    const p = new DockerProvider();
    await expect(p.getMachineState('abc')).rejects.toThrow('socket closed');
  });

  it('getMachineInfo returns normalized MachineInfo', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Name: '/silly_einstein',
      State: { Status: 'running' },
      Config: { Labels: { 'runhq.serverId': 'srv-1' } },
    });
    const p = new DockerProvider();
    const info = await p.getMachineInfo('aaaaaaaaaaaa');
    expect(info).toEqual({
      id: 'aaaaaaaaaaaa',
      name: 'silly_einstein',
      state: 'running',
      region: 'local',
    });
  });

  it('getMachineInfo propagates 404 errors (does not swallow)', async () => {
    const err = Object.assign(new Error('No such container'), { statusCode: 404 });
    mockInspect.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.getMachineInfo('gone')).rejects.toThrow();
  });
});

describe('DockerProvider — lifecycle ops', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockStart = vi.fn();
  const mockStop = vi.fn();
  const mockRestart = vi.fn();
  const mockPause = vi.fn();
  const mockUnpause = vi.fn();
  const mockInspect = vi.fn();
  const mockRemove = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue({
      start: mockStart,
      stop: mockStop,
      restart: mockRestart,
      pause: mockPause,
      unpause: mockUnpause,
      inspect: mockInspect,
      remove: mockRemove,
    });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('startMachine calls container.start', async () => {
    mockStart.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.startMachine('abc');
    expect(mockStart).toHaveBeenCalled();
  });

  it('startMachine swallows "already started" errors (304)', async () => {
    const err = Object.assign(new Error('not modified'), { statusCode: 304 });
    mockStart.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.startMachine('abc')).resolves.toBeUndefined();
  });

  it('startMachine unpauses paused containers when Docker rejects start with 409', async () => {
    const err = Object.assign(new Error('cannot start a paused container, try unpause instead'), { statusCode: 409 });
    mockStart.mockRejectedValueOnce(err);
    mockInspect.mockResolvedValueOnce({ State: { Status: 'paused' } });
    mockUnpause.mockResolvedValueOnce(undefined);

    const p = new DockerProvider();
    await expect(p.startMachine('abc')).resolves.toBeUndefined();

    expect(mockInspect).toHaveBeenCalledTimes(1);
    expect(mockUnpause).toHaveBeenCalledTimes(1);
  });

  it('startMachine rethrows 409 conflicts for non-paused containers', async () => {
    const err = Object.assign(new Error('conflict'), { statusCode: 409 });
    mockStart.mockRejectedValueOnce(err);
    mockInspect.mockResolvedValueOnce({ State: { Status: 'running' } });

    const p = new DockerProvider();
    await expect(p.startMachine('abc')).rejects.toThrow('conflict');
    expect(mockUnpause).not.toHaveBeenCalled();
  });

  it('stopMachine calls container.stop with timeout', async () => {
    mockStop.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.stopMachine('abc');
    expect(mockStop).toHaveBeenCalledWith({ t: 10 });
  });

  it('stopMachine swallows "already stopped" (304)', async () => {
    const err = Object.assign(new Error('not modified'), { statusCode: 304 });
    mockStop.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.stopMachine('abc')).resolves.toBeUndefined();
  });

  it('restartMachine calls container.restart', async () => {
    mockRestart.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.restartMachine('abc');
    expect(mockRestart).toHaveBeenCalled();
  });

  it('suspendMachine calls container.pause', async () => {
    mockPause.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.suspendMachine('abc');
    expect(mockPause).toHaveBeenCalled();
  });

  it('deleteMachine stops then removes', async () => {
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);
    const p = new DockerProvider();
    await p.deleteMachine('abc');
    expect(mockStop).toHaveBeenCalledWith({ t: 10 });
    expect(mockRemove).toHaveBeenCalled();
  });

  it('deleteMachine ignores 404 on stop and remove', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    mockStop.mockRejectedValueOnce(err);
    mockRemove.mockRejectedValueOnce(err);
    const p = new DockerProvider();
    await expect(p.deleteMachine('gone')).resolves.toBeUndefined();
  });
});

describe('DockerProvider — recreate ops', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();
  const mockStop = vi.fn();
  const mockRemove = vi.fn();
  const mockStart = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = '/tmp/runhq-vols';
    mockGetContainer.mockReturnValue({ inspect: mockInspect, stop: mockStop, remove: mockRemove });
    mockListImages.mockResolvedValue([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);
    mockCreateContainer.mockResolvedValue({ id: 'b'.repeat(64), start: mockStart });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    delete process.env.RUNHQ_LOCAL_VOLUMES_DIR;
    delete process.env.RUNHQ_WORKSPACE_IMAGE;
  });

  it('updateMachineImage stops, removes, recreates with new image', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Image: 'runhq-server:local',
      Config: {
        Image: 'runhq-server:local',
        Env: ['SERVER_TOKEN=t', 'PORT=61987'],
        Labels: {
          'runhq.managed': 'true',
          'runhq.serverId': 'srv-1',
          'runhq.volumeId': 'v-1',
          'runhq.tier': 'shared-4x-2gb',
          'runhq.hostPort': '12345',
        },
        ExposedPorts: { '61987/tcp': {} },
      },
      HostConfig: {
        Binds: ['/tmp/runhq-vols/v-1:/app/data'],
        PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }] },
        NanoCpus: 4_000_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);

    process.env.RUNHQ_WORKSPACE_IMAGE = 'runhq-server:v2';
    mockListImages.mockResolvedValue([{ Id: 'sha256:def', RepoTags: ['runhq-server:v2'] }]);

    const p = new DockerProvider();
    await p.updateMachineImage('abc');

    expect(mockStop).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();
    const spec = mockCreateContainer.mock.calls[0][0];
    expect(spec.Image).toBe('runhq-server:v2');
    expect(spec.Labels).toMatchObject({ 'runhq.serverId': 'srv-1' });
    expect(spec.HostConfig.Binds).toEqual(['/tmp/runhq-vols/v-1:/app/data']);
    expect(spec.HostConfig.PortBindings['61987/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: '12345' },
    ]);
    expect(mockStart).toHaveBeenCalled();
  });

  it('updateMachineEnv recreates with merged env', async () => {
    mockInspect.mockResolvedValueOnce({
      Id: 'a'.repeat(64),
      Config: {
        Image: 'runhq-server:local',
        Env: ['SERVER_TOKEN=old', 'PORT=61987', 'EXTRA=keep'],
        Labels: {
          'runhq.managed': 'true',
          'runhq.serverId': 'srv-1',
          'runhq.volumeId': 'v-1',
          'runhq.tier': 'shared-4x-2gb',
          'runhq.hostPort': '12345',
        },
        ExposedPorts: { '61987/tcp': {} },
      },
      HostConfig: {
        Binds: ['/tmp/runhq-vols/v-1:/app/data'],
        PortBindings: { '61987/tcp': [{ HostIp: '127.0.0.1', HostPort: '12345' }] },
        NanoCpus: 4_000_000_000,
        Memory: 2 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    mockStop.mockResolvedValueOnce(undefined);
    mockRemove.mockResolvedValueOnce(undefined);

    const p = new DockerProvider();
    await p.updateMachineEnv('abc', { SERVER_TOKEN: 'new', NEW_KEY: 'val' });

    const spec = mockCreateContainer.mock.calls[0][0];
    expect(spec.Env).toEqual(expect.arrayContaining([
      'SERVER_TOKEN=new',
      'PORT=61987',
      'EXTRA=keep',
      'NEW_KEY=val',
    ]));
  });
});

describe('DockerProvider — waiting', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;
  const mockInspect = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetContainer.mockReturnValue({ inspect: mockInspect });
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  it('waitForState resolves once state matches', async () => {
    mockInspect
      .mockResolvedValueOnce({ State: { Status: 'restarting' } })
      .mockResolvedValueOnce({ State: { Status: 'restarting' } })
      .mockResolvedValueOnce({ State: { Status: 'running' } });
    const p = new DockerProvider();
    await expect(p.waitForState('abc', ['running'], 5_000)).resolves.toBeUndefined();
    expect(mockInspect).toHaveBeenCalledTimes(3);
  });

  it('waitForState times out with last observed state in message', async () => {
    mockInspect.mockResolvedValue({ State: { Status: 'restarting' } });
    const p = new DockerProvider();
    await expect(p.waitForState('abc', ['running'], 200)).rejects.toThrow(
      /timed out.*last state.*starting/i,
    );
  });

  it('waitForHealthy polls /health and resolves on 200', async () => {
    mockInspect.mockResolvedValue({
      Config: { Labels: { 'runhq.hostPort': '54321' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = new DockerProvider();
    await expect(p.waitForHealthy('abc', 5_000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:54321/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('waitForHealthy times out if /health never returns 200', async () => {
    mockInspect.mockResolvedValue({
      Config: { Labels: { 'runhq.hostPort': '54321' } },
    });
    global.fetch = vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch;

    const p = new DockerProvider();
    await expect(p.waitForHealthy('abc', 200)).rejects.toThrow(/timed out/i);
  });
});

describe('DockerProvider — routing and fleet', () => {
  let DockerProvider: typeof import('./DockerProvider').DockerProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Ensure URL templates / fly-preview detection don't leak from process env.
    delete process.env.RUNHQ_WORKSPACE_PUBLIC_URL_TEMPLATE;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.RUNHQ_MACHINE_ID;
    delete process.env.RUNHQ_PREVIEW_DOMAIN;
    ({ DockerProvider } = await import('./DockerProvider'));
  });

  afterEach(() => {
    delete process.env.RUNHQ_WORKSPACE_PUBLIC_URL_TEMPLATE;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.RUNHQ_MACHINE_ID;
    delete process.env.RUNHQ_PREVIEW_DOMAIN;
  });

  it('getRoutingInfo reads hostPort from the appName argument', () => {
    const p = new DockerProvider();
    expect(p.getRoutingInfo('abc', '54321')).toEqual({
      serverUrl: 'http://localhost:54321',
      routingToken: null,
      requiresRoutingHeaders: false,
    });
  });

  it('getRoutingInfo returns empty serverUrl when appName is missing or not a numeric port', () => {
    const empty = { serverUrl: '', routingToken: null, requiresRoutingHeaders: false };
    const p = new DockerProvider();
    // Missing / empty — caller should fall back to servers.serverUrl.
    expect(p.getRoutingInfo('abc', null)).toEqual(empty);
    expect(p.getRoutingInfo('abc', '')).toEqual(empty);
    expect(p.getRoutingInfo('abc')).toEqual(empty);
    // Non-numeric (e.g. the per-tenant Fly app name ServerService stores into
    // servers.flyAppName) is treated the same as missing.
    expect(p.getRoutingInfo('abc', 'ws-foo-bar')).toEqual(empty);
  });

  it('updateAutoSuspendPolicy is a no-op', async () => {
    const p = new DockerProvider();
    await expect(p.updateAutoSuspendPolicy('abc', true)).resolves.toBeUndefined();
  });

  it('listMachines filters by runhq.managed label and returns MachineInfo[]', async () => {
    mockListContainers.mockResolvedValueOnce([
      {
        Id: 'c'.repeat(64),
        Names: ['/wild_curie'],
        State: 'running',
        Labels: { 'runhq.managed': 'true', 'runhq.serverId': 'srv-1' },
      },
      {
        Id: 'd'.repeat(64),
        Names: ['/serene_kepler'],
        State: 'exited',
        Labels: { 'runhq.managed': 'true', 'runhq.serverId': 'srv-2' },
      },
    ]);
    const p = new DockerProvider();
    const machines = await p.listMachines();
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['runhq.managed=true'] },
    });
    expect(machines).toEqual([
      { id: 'cccccccccccc', name: 'wild_curie', state: 'running', region: 'local' },
      { id: 'dddddddddddd', name: 'serene_kepler', state: 'stopped', region: 'local' },
    ]);
  });
});
