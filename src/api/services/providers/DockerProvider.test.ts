import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
