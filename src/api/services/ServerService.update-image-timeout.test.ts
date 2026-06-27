/**
 * Regression: the server-image-update path must give the machine a readiness
 * budget appropriate to its work.
 *
 * `restartRemoteServer` (reached via the `/api/servers/:id/server/update`
 * endpoint → `updateRemoteServer`) does the heaviest restart there is: it
 * commits a NEW image to the Fly machine config, which triggers Fly to pull a
 * fresh image layer from the registry and reboot the machine. That is strictly
 * slower than a plain wake/restart (cached image) and is image-pull-class work,
 * exactly like provisioning.
 *
 * The bug: the image-update path waited only 30 000 ms for the machine to
 * reach the `started` state, while every other lifecycle flow in
 * ServerService waits far longer (plain wake/restart: 90 000 ms; provisioning:
 * 600 000 ms). On real Fly machines the image pull + boot routinely exceeds
 * 30 s, so `waitForState` threw `Timeout waiting for machine … to reach
 * state: started`, which the catch turned into `{ error: 'Failed to restart
 * server' }` — even though the image update had already been committed
 * successfully and the machine came up healthy moments later.
 *
 * Real incident (2026-05-17, prod, ws_mm4nv80x_5n8q9e):
 *   [FlyService] Updating machine 17812613c21d08 image: …b06490c1 → …675f0648
 *   [ServerService] Failed to restart machine: Error: Timeout waiting for
 *     machine 17812613c21d08 to reach state: started
 * (failure fired ~31 s after the update call; the new image `675f0648` was
 * live, and the UI showed it after a refresh.)
 *
 * This test reproduces that exact shape: the update API call succeeds, the
 * machine takes longer than the old 30 s window to reach `started`, and the
 * operation must still report success. It also pins a lower bound on the
 * readiness budget so the regression can't silently return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — same harness shape as ServerService.metadata-durability.test.ts.
// ServerService pulls these in at module scope; they must be mocked or the
// import fails.
// ---------------------------------------------------------------------------

type UpdatePayload = Record<string, unknown>;
const captured: UpdatePayload[] = [];

const dbMock = {
  update: vi.fn(() => ({
    set: vi.fn((values: UpdatePayload) => {
      captured.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  })),
  query: {
    servers: { findFirst: vi.fn() },
  },
};

vi.mock('../../db/index', () => ({ db: dbMock }));
vi.mock('../../db/schema', () => {
  const col = (name: string) => ({ _colName: name });
  return {
    servers: { id: col('id'), machineId: col('machine_id'), ownerId: col('owner_id') },
    serverMembers: { serverId: col('server_id'), userId: col('user_id'), role: col('role'), isAdmin: col('is_admin') },
    serverInvites: { serverId: col('server_id') },
    serverInviteLinks: { serverId: col('server_id') },
    serverBans: { serverId: col('server_id') },
    serverTemplates: { serverId: col('server_id') },
    publicPorts: { serverId: col('server_id') },
    workspaceTasks: { serverId: col('server_id') },
    workspaceTaskComments: {},
    workspaceTaskActivity: {},
    workspaceTaskAttachments: {},
    workspaceTaskVotes: {},
    users: { id: col('id'), email: col('email') },
  };
});
vi.mock('../../db/services', () => ({ getUserByEmail: vi.fn() }));
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(() => ({})), and: vi.fn(() => ({})), gt: vi.fn(() => ({})), lte: vi.fn(() => ({})), isNull: vi.fn(() => ({})), isNotNull: vi.fn(() => ({})), inArray: vi.fn(() => ({})), sql: vi.fn(() => ({})) };
});

const providerMock = {
  getMachineState: vi.fn(),
  createMachine: vi.fn(),
  updateMachineImage: vi.fn(),
  updateMachineEnv: vi.fn(),
  waitForState: vi.fn(),
  waitForHealthy: vi.fn(),
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  suspendMachine: vi.fn(),
  restartMachine: vi.fn(),
  deleteMachine: vi.fn(),
  getRegions: vi.fn(() => [{ id: 'iad' }, { id: 'ams' }]),
  getTierSpecs: vi.fn(() => [{ tierId: 'perf-2x-8gb', diskGb: 60 }]),
  getVolume: vi.fn(async () => ({ sizeGb: 60 })),
  forkVolume: vi.fn(async () => ({ id: 'vol-forked' })),
  extendVolume: vi.fn(),
  deleteVolume: vi.fn(),
  createSnapshot: vi.fn(async () => ({ id: 'snap' })),
  createVolumeFromSnapshot: vi.fn(async () => ({ id: 'vol-restored' })),
  waitForVolumeReady: vi.fn(),
  createApp: vi.fn(),
  deleteApp: vi.fn(),
  allocateIPs: vi.fn(),
  addCertificate: vi.fn(),
  getRoutingInfo: vi.fn(() => ({ serverUrl: '' })),
  id: 'fly',
};

vi.mock('./providers/registry', () => ({
  getProvider: () => providerMock,
  isAnyProviderConfigured: () => true,
  getDefaultProviderId: () => 'fly',
}));
vi.mock('./providers/FlyProvider', () => ({
  flyTierToTierId: (t: string) => t,
  tierIdToFlyTier: (t: string) => t,
}));
vi.mock('./CloudflareTunnelService', () => ({
  // false → ensureServerTunnelConnector returns null immediately, so the
  // test exercises the image-update + readiness-wait path in isolation.
  isConfigured: () => false,
  getTunnelToken: vi.fn(async () => 'tok'),
  deleteTunnel: vi.fn(),
  addIngressRule: vi.fn(),
  createDnsRecord: vi.fn(),
}));
vi.mock('./PublicPortService', () => ({}));
vi.mock('./UsageService', () => ({
  getOrCreateSubscription: vi.fn(async () => ({ stripeCustomerId: 'cus_x' })),
  PLAN_CONFIG: {},
  isAdmin: vi.fn(async () => false),
}));
vi.mock('./MachineUsageService', () => ({
  onMachineStarted: vi.fn(),
  onMachineStopped: vi.fn(),
}));
vi.mock('./ServerSessionService', () => ({
  generateServerSessionToken: vi.fn(),
}));
vi.mock('@/lib/workspaceMfaEnforcement', () => ({
  computeMfaEnforcement: vi.fn(),
}));

// ---------------------------------------------------------------------------

let ServerService: typeof import('./ServerService');

// `db.select().from(...).where(...).limit(N)` — the chain used by
// checkServerPermission, checkCloudOpPermission and getServer. Responses are
// returned in call order.
function mockSelectSequence(responses: unknown[]) {
  let i = 0;
  (dbMock as any).select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          const r = responses[i++];
          if (r === undefined) return [];
          return Array.isArray(r) ? r : [r];
        }),
      })),
    })),
  }));
}

beforeEach(async () => {
  captured.length = 0;
  vi.resetAllMocks();

  dbMock.update.mockImplementation(() => ({
    set: vi.fn((values: UpdatePayload) => {
      captured.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));

  vi.resetModules();
  ServerService = await import('./ServerService');
});

describe('updateRemoteServer / restartRemoteServer — image-update readiness budget', () => {
  const remoteServer = {
    id: 'ws_test',
    deploymentType: 'remote' as const,
    machineId: 'mach_test',
    machineName: 'srv-test',
    serverUrl: 'https://fishtank-workspaces.fly.dev',
    tunnelId: 'tun_test',
    volumeId: 'vol_test',
    provider: 'fly',
    ownerId: 'user_test',
    status: 'online' as const,
  };

  // Owner permission for checkServerPermission(['owner']) and
  // checkCloudOpPermission, then the server row twice (restartRemoteServer's
  // getServer + ensureServerTunnelConnector's getServer).
  function primeOwnerAndServer() {
    mockSelectSequence([
      { role: 'owner' },
      { role: 'owner', isAdmin: false },
      remoteServer,
      remoteServer,
    ]);
  }

  // A Fly machine that pulls a fresh image then boots takes well over the old
  // 30 s window to reach `started`. Model the real waitForMachine contract:
  // resolve only if the caller's timeout covers the boot, otherwise throw the
  // exact production error.
  const SIMULATED_BOOT_MS = 60_000;
  function simulateSlowImagePullBoot() {
    providerMock.updateMachineImage.mockResolvedValue(undefined);
    providerMock.waitForState.mockImplementation(
      async (_machineId: string, _states: string[], timeoutMs?: number) => {
        if ((timeoutMs ?? 0) < SIMULATED_BOOT_MS) {
          throw new Error(
            `Timeout waiting for machine ${remoteServer.machineId} to reach state: started`,
          );
        }
        return undefined;
      },
    );
    providerMock.waitForHealthy.mockResolvedValue(undefined);
  }

  it('reports success when the image update is committed but the machine takes >30s to reach started', async () => {
    primeOwnerAndServer();
    simulateSlowImagePullBoot();

    const result = await ServerService.updateRemoteServer('ws_test', 'user_test');

    // The image update API call succeeded; a slow-but-successful boot must NOT
    // be reported to the user as "Failed to restart server".
    expect(providerMock.updateMachineImage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      status: 'online',
      url: 'https://fishtank-workspaces.fly.dev',
    });
    expect(result.error).toBeUndefined();
  });

  it('gives the image-pull restart at least the plain-restart readiness budget', async () => {
    primeOwnerAndServer();
    simulateSlowImagePullBoot();

    await ServerService.updateRemoteServer('ws_test', 'user_test');

    // An image pull + reboot is strictly heavier than a cached-image
    // wake/restart (90 000 ms / 60 000 ms in ServerService). The
    // image-update path must never impose a *shorter* budget than that —
    // the 30 000 ms outlier was the bug.
    expect(providerMock.waitForState).toHaveBeenCalledTimes(1);
    const stateTimeout = providerMock.waitForState.mock.calls[0][2] as number;
    expect(stateTimeout).toBeGreaterThanOrEqual(90_000);

    expect(providerMock.waitForHealthy).toHaveBeenCalledTimes(1);
    const healthTimeout = providerMock.waitForHealthy.mock.calls[0][1] as number;
    expect(healthTimeout).toBeGreaterThanOrEqual(60_000);
  });
});
