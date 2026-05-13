/**
 * Integration test: with LOCAL_PROVIDER=docker, the registry hands out a
 * DockerProvider whose createMachine produces a localhost URL.
 *
 * This exercises the wiring across registry.ts, DockerProvider.ts, and
 * (transitively) types.ts — confirming a "Create Server" call path that
 * goes through getDefaultProviderId() + getProvider() ends with the right
 * shape of result. dockerode is mocked end-to-end; ServerService is not
 * touched (its dependency tree is large and tested separately by the
 * existing ServerService tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockPing = vi.fn();
const mockListImages = vi.fn();
const mockCreateContainer = vi.fn();

vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => ({
    ping: mockPing,
    listImages: mockListImages,
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    buildImage: vi.fn(),
    createContainer: mockCreateContainer,
  })),
}));

const originalEnv = { ...process.env };

describe('local provider end-to-end flow', () => {
  let baseDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    baseDir = mkdtempSync(join(tmpdir(), 'runhq-e2e-'));
    process.env.LOCAL_PROVIDER = 'docker';
    process.env.RUNHQ_LOCAL_VOLUMES_DIR = baseDir;
    process.env.CLOUD_API_URL = 'http://test.cloud';
    process.env.SERVER_SESSION_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nTESTKEY\n-----END PUBLIC KEY-----';
    delete process.env.RUNHQ_WORKSPACE_IMAGE;

    mockPing.mockResolvedValue('OK');
    mockListImages.mockResolvedValue([{ Id: 'sha256:abc', RepoTags: ['runhq-server:local'] }]);
    mockCreateContainer.mockResolvedValue({
      id: 'a'.repeat(64),
      start: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('LOCAL_PROVIDER=docker selects DockerProvider and createMachine returns localhost URL', async () => {
    const { initProviders, getProvider, getDefaultProviderId } = await import('./registry');
    initProviders();

    expect(getDefaultProviderId()).toBe('docker');

    const provider = getProvider(getDefaultProviderId());
    expect(provider.id).toBe('docker');

    const vol = await provider.createVolume('my-server', 'local', 10);
    const result = await provider.createMachine({
      serverId: 'srv-end-to-end',
      serverToken: 'session-tok',
      region: 'local',
      tier: 'shared-4x-2gb',
      existingVolumeId: vol.id,
      autoSuspendEnabled: false,
      appName: null,
      networkName: null,
    });

    expect(result.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(result.machineId).toMatch(/^[a-f0-9]{12}$/);
    expect(result.appName).toMatch(/^\d+$/);
    expect(result.region).toBe('local');

    // getRoutingInfo, called later from request handlers with `server.flyAppName`,
    // reconstructs the URL synchronously from the persisted port:
    const routing = provider.getRoutingInfo(result.machineId, result.appName);
    expect(routing.serverUrl).toBe(result.serverUrl);
  });
});
