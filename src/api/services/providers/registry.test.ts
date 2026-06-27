import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dockerode so DockerProvider construction works without a daemon.
vi.mock('dockerode', () => ({
  default: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue('OK'),
    listImages: vi.fn().mockResolvedValue([]),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    buildImage: vi.fn(),
    createContainer: vi.fn(),
  })),
}));

const originalEnv = { ...process.env };

describe('registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete (process.env as Record<string, string | undefined>).LOCAL_PROVIDER;
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getDefaultProviderId returns docker when LOCAL_PROVIDER=docker', async () => {
    process.env.LOCAL_PROVIDER = 'docker';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('getDefaultProviderId returns fly when LOCAL_PROVIDER=fly', async () => {
    process.env.LOCAL_PROVIDER = 'fly';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('fly');
  });

  it('getDefaultProviderId returns docker when NODE_ENV is not production', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('getDefaultProviderId returns fly when NODE_ENV=production and no override', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('fly');
  });

  it('LOCAL_PROVIDER override beats NODE_ENV', async () => {
    process.env.LOCAL_PROVIDER = 'docker';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const { getDefaultProviderId } = await import('./registry');
    expect(getDefaultProviderId()).toBe('docker');
  });

  it('initProviders registers both fly and docker', async () => {
    const { initProviders, getProvider } = await import('./registry');
    initProviders();
    expect(getProvider('fly').id).toBe('fly');
    expect(getProvider('docker').id).toBe('docker');
  });

  it('getHourlyRate returns 0 cents for docker', async () => {
    const { getHourlyRate } = await import('./registry');
    expect(getHourlyRate('docker', 'shared-4x-2gb')).toBe(0);
    expect(getHourlyRate('docker', 'perf-4x-32gb')).toBe(0);
  });

  it('getHourlyRate still returns Fly rates for fly', async () => {
    const { getHourlyRate } = await import('./registry');
    expect(getHourlyRate('fly', 'shared-4x-2gb')).toBe(3);
  });
});
