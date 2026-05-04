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
    process.env.CLOUD_API_URL = 'http://test.cloud';

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
    expect(spec.Env).toEqual(expect.arrayContaining([
      'SERVER_TOKEN=session-token',
      'CLOUD_API_URL=http://test.cloud',
      'PORT=61987',
      'NODE_ENV=production',
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
    expect(spec.HostConfig.NanoCpus).toBe(4_000_000_000);
    expect(spec.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
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
