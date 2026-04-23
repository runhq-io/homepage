/**
 * Tests for Fly.io Service
 *
 * Note: Since FlyService reads env vars at module load time, we need to
 * reset modules between tests to pick up new env values.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Store original env
const originalEnv = { ...process.env };

describe('FlyService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let FlyService: typeof import('./FlyService');

  beforeAll(() => {
    // Mock fetch globally
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterAll(() => {
    // Restore original env
    process.env = originalEnv;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Set env vars before importing
    process.env.FLY_API_TOKEN = 'test-fly-token';
    process.env.FLY_APP_NAME = 'test-app';
    process.env.CLOUD_API_URL = 'https://api.test.com';
    // createMachine / updateMachineImage now fail-fast without this env var
    // (the workspace requires it to verify session JWTs). Set a realistic
    // PEM so assertions can verify it is forwarded to the machine.
    process.env.SERVER_SESSION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0sjXscAx1uBS3Ny36JpFbfQva3FF6Rn5Y1foMvJ0HEY=
-----END PUBLIC KEY-----`;
    delete process.env.SERVER_MACHINE_AUTOSTOP;
    delete process.env.SERVER_MACHINE_AUTOSTART;
    delete process.env.SERVER_MIN_MACHINES_RUNNING;

    // Re-import with fresh env
    FlyService = await import('./FlyService');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('should return true when FLY_API_TOKEN is set', () => {
      expect(FlyService.isConfigured()).toBe(true);
    });
  });

  describe('getAppName', () => {
    it('should return the configured app name', () => {
      expect(FlyService.getAppName()).toBe('test-app');
    });
  });

  describe('listMachines', () => {
    it('should list all machines', async () => {
      const mockMachines = [
        { id: 'machine-1', name: 'srv-abc-123', state: 'started', region: 'iad' },
        { id: 'machine-2', name: 'srv-def-456', state: 'stopped', region: 'iad' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockMachines)),
      });

      const result = await FlyService.listMachines();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-fly-token',
          }),
        })
      );
      expect(result).toEqual(mockMachines);
    });
  });

  describe('getMachine', () => {
    it('should get a machine by ID', async () => {
      const mockMachine = {
        id: 'machine-1',
        name: 'srv-abc-123',
        state: 'started',
        region: 'iad',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockMachine)),
      });

      const result = await FlyService.getMachine('machine-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines/machine-1',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual(mockMachine);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Machine not found'),
      });

      await expect(FlyService.getMachine('invalid-id')).rejects.toThrow(
        'Fly.io API error: 404'
      );
    });
  });

  describe('createMachine', () => {
    // Note: getLatestReleaseImage reads from the DB (systemSettings table),
    // not from Fly's GraphQL API, so there is no leading GraphQL mock.
    // getOrCreateVolume goes straight to createVolume when no
    // existingVolumeId is passed — no listVolumes call.
    it('should create a machine with correct config', async () => {
      // Mock createVolume
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'vol-123',
          name: 'data_projid',
          region: 'iad',
        })),
      });

      // Mock createMachine
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'machine-new',
          name: 'srv-projid-abc123',
          state: 'created',
          region: 'iad',
        })),
      });

      const result = await FlyService.createMachine({
        serverId: 'proj-id-123',
        serverToken: 'wst_test_token_123',
        region: 'iad',
      });

      expect(result.machineId).toBe('machine-new');
      expect(result.region).toBe('iad');
      expect(result.url).toContain('.fly.dev');
      expect(result.volumeId).toBe('vol-123');

      // Verify machine creation call (createVolume=0, createMachine=1)
      const machineCall = mockFetch.mock.calls[1];
      expect(machineCall[0]).toBe('https://api.machines.dev/v1/apps/test-app/machines');
      expect(machineCall[1].method).toBe('POST');

      const body = JSON.parse(machineCall[1].body);
      expect(body.region).toBe('iad');
      expect(body.config.env.SERVER_TOKEN).toBe('wst_test_token_123');
      expect(body.config.env.SERVER_ID).toBe('proj-id-123');
      expect(body.config.env.AUTH_MODE).toBe('cloud');
      // The workspace needs the public key to verify BE-signed session JWTs.
      expect(body.config.env.SERVER_SESSION_PUBLIC_KEY_PEM).toContain('BEGIN PUBLIC KEY');
      // The legacy shared HMAC secret must NOT be forwarded — that was the
      // forgery-material vector we closed.
      expect(body.config.env.SERVER_SESSION_SECRET).toBeUndefined();
      expect(body.config.services[0].internal_port).toBe(61987);
      expect(body.config.services[0].autostop).toBe('suspend');
      expect(body.config.services[0].autostart).toBe(true);
      expect(body.config.services[0].min_machines_running).toBe(0);
      expect(body.config.guest.memory_mb).toBe(2048);
    });

    it('should reuse an existing volume when existingVolumeId is passed and matches the region', async () => {
      // Mock getVolume (returns a volume in the requested region)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'existing-vol',
          name: 'data_projid123',
          region: 'iad',
          state: 'created',
        })),
      });

      // Mock createMachine
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'machine-new',
          name: 'srv-projid-abc123',
          state: 'created',
          region: 'iad',
        })),
      });

      const result = await FlyService.createMachine({
        serverId: 'proj-id-123',
        serverToken: 'wst_test_token',
        region: 'iad',
        existingVolumeId: 'existing-vol',
      });

      expect(result.volumeId).toBe('existing-vol');
      expect(mockFetch).toHaveBeenCalledTimes(2); // getVolume + createMachine (createVolume skipped)
    });

    it('throws before making any Fly API call when SERVER_SESSION_PUBLIC_KEY_PEM is missing', async () => {
      // A misconfigured BE (missing public key) must NOT create a machine
      // that would immediately boot-loop — the workspace fail-fasts without
      // this env var. Verify the guard fires before any outbound request.
      delete process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
      FlyService = await import('./FlyService');

      await expect(
        FlyService.createMachine({
          serverId: 'proj-id-123',
          serverToken: 'wst_test_token',
          region: 'iad',
        }),
      ).rejects.toThrow(/SERVER_SESSION_PUBLIC_KEY_PEM/);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should honor server machine lifecycle env overrides', async () => {
      process.env.SERVER_MACHINE_AUTOSTOP = 'off';
      process.env.SERVER_MACHINE_AUTOSTART = 'false';
      process.env.SERVER_MIN_MACHINES_RUNNING = '1';
      FlyService = await import('./FlyService');

      // Mock createVolume
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'vol-123',
          name: 'data_projid123',
          region: 'iad',
        })),
      });

      // Mock createMachine
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'machine-new',
          name: 'srv-projid-abc123',
          state: 'created',
          region: 'iad',
        })),
      });

      await FlyService.createMachine({
        serverId: 'proj-id-123',
        serverToken: 'wst_test_token',
        region: 'iad',
      });

      const machineCall = mockFetch.mock.calls[1]; // createVolume=0, createMachine=1
      const body = JSON.parse(machineCall[1].body);

      expect(body.config.services[0].autostop).toBe('off');
      expect(body.config.services[0].autostart).toBe(false);
      expect(body.config.services[0].min_machines_running).toBe(1);
    });
  });

  describe('updateMachineAutoSuspend', () => {
    it('should disable autosuspend for an existing machine', async () => {
      // Mock getMachine
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'machine-1',
          name: 'srv-projid-abc123',
          state: 'started',
          region: 'iad',
          config: {
            image: 'registry.fly.io/test-app:deployment-123',
            env: {
              SERVER_ID: 'proj-id-123',
            },
            guest: {
              cpu_kind: 'shared',
              cpus: 1,
              memory_mb: 1024,
            },
            services: [
              {
                ports: [
                  { port: 443, handlers: ['tls', 'http'] },
                  { port: 80, handlers: ['http'] },
                ],
                protocol: 'tcp',
                internal_port: 61987,
                autostop: 'suspend',
                autostart: true,
                min_machines_running: 0,
              },
            ],
          },
        })),
      });

      // Mock updateMachine
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          id: 'machine-1',
          name: 'srv-projid-abc123',
          state: 'started',
          region: 'iad',
        })),
      });

      await FlyService.updateMachineAutoSuspend('machine-1', false);

      const updateCall = mockFetch.mock.calls[1];
      expect(updateCall[0]).toBe('https://api.machines.dev/v1/apps/test-app/machines/machine-1');
      expect(updateCall[1].method).toBe('POST');

      const body = JSON.parse(updateCall[1].body);
      expect(body.config.services[0].autostop).toBe('off');
      expect(body.config.services[0].autostart).toBe(true);
      expect(body.config.services[0].min_machines_running).toBe(1);
    });
  });

  describe('startMachine', () => {
    it('should start a machine', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await FlyService.startMachine('machine-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines/machine-1/start',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('stopMachine', () => {
    it('should stop a machine', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await FlyService.stopMachine('machine-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines/machine-1/stop',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('suspendMachine', () => {
    it('should suspend a machine', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await FlyService.suspendMachine('machine-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines/machine-1/suspend',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('deleteMachine', () => {
    it('should delete a machine with force flag', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await FlyService.deleteMachine('machine-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/machines/machine-1?force=true',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('waitForMachine', () => {
    it('should return immediately if machine is in target state', async () => {
      const mockMachine = { id: 'machine-1', state: 'started' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockMachine)),
      });

      const result = await FlyService.waitForMachine('machine-1', ['started'], 5000);

      expect(result.state).toBe('started');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should poll until target state is reached', async () => {
      // First call: starting
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: 'machine-1', state: 'starting' })),
      });
      // Second call: started
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: 'machine-1', state: 'started' })),
      });

      const result = await FlyService.waitForMachine('machine-1', ['started'], 5000);

      expect(result.state).toBe('started');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw if machine is destroyed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: 'machine-1', state: 'destroyed' })),
      });

      await expect(
        FlyService.waitForMachine('machine-1', ['started'], 5000)
      ).rejects.toThrow('Machine machine-1 was destroyed');
    });

    it('should timeout if target state not reached', async () => {
      // Always return 'starting'
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ id: 'machine-1', state: 'starting' })),
      });

      await expect(
        FlyService.waitForMachine('machine-1', ['started'], 100) // Very short timeout
      ).rejects.toThrow('Timeout waiting for machine');
    }, 5000);
  });

  describe('listVolumes', () => {
    it('should list all volumes', async () => {
      const mockVolumes = [
        { id: 'vol-1', name: 'data_proj1', region: 'iad' },
        { id: 'vol-2', name: 'data_proj2', region: 'iad' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockVolumes)),
      });

      const result = await FlyService.listVolumes();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/volumes',
        expect.objectContaining({ method: 'GET' })
      );
      expect(result).toEqual(mockVolumes);
    });
  });

  describe('createVolume', () => {
    it('should create a volume with encryption', async () => {
      const mockVolume = {
        id: 'vol-new',
        name: 'data_test',
        region: 'iad',
        size_gb: 2,
        encrypted: true,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(mockVolume)),
      });

      const result = await FlyService.createVolume('data_test', 'iad', 2);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/volumes',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'data_test',
            region: 'iad',
            size_gb: 2,
            encrypted: true,
          }),
        })
      );
      expect(result).toEqual(mockVolume);
    });
  });

  describe('deleteVolume', () => {
    it('should delete a volume', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await FlyService.deleteVolume('vol-1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.machines.dev/v1/apps/test-app/volumes/vol-1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});

describe('FlyService (unconfigured)', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Clear env vars
    delete process.env.FLY_API_TOKEN;
    process.env.FLY_APP_NAME = 'test-app';
  });

  it('should return false for isConfigured when token not set', async () => {
    const FlyService = await import('./FlyService');
    expect(FlyService.isConfigured()).toBe(false);
  });
});
