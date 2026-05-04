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
