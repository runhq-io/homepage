/**
 * Regression: when a provider must RECREATE the machine to update its image
 * (the Docker provider can't swap a running container's image in place, so it
 * stops+removes+creates a fresh container with a NEW id), `restartRemoteServer`
 * must:
 *   1. persist the new id to `servers.machineId`, and
 *   2. run the readiness waits against the NEW id — not the removed one.
 *
 * The bug this guards against: `restartRemoteServer` recreated the container
 * (good) but then called `waitForState(OLD_id, ['running'], 600_000)`. The old
 * container was already gone, so `getMachineState` returned `destroyed`
 * forever, `waitForState` ran the full 10-minute budget and threw, and the
 * operation reported "Failed to restart server" — leaving `servers.machineId`
 * pointing at a dead container. On Fly the id is stable so this never showed;
 * only the local Docker provider hit it.
 *
 * Harness shape mirrors ServerService.update-image-timeout.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type UpdatePayload = Record<string, unknown>;
const captured: UpdatePayload[] = [];

const dbMock = {
  update: vi.fn(() => ({
    set: vi.fn((values: UpdatePayload) => {
      captured.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  })),
  query: { servers: { findFirst: vi.fn() } },
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
  getRegions: vi.fn(() => [{ id: 'iad' }]),
  getTierSpecs: vi.fn(() => [{ tierId: 'shared-4x-2gb', diskGb: 20 }]),
  getVolume: vi.fn(async () => ({ sizeGb: 20 })),
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
  id: 'docker',
};

vi.mock('./providers/registry', () => ({
  getProvider: () => providerMock,
  isAnyProviderConfigured: () => true,
  getDefaultProviderId: () => 'docker',
}));
vi.mock('./providers/FlyProvider', () => ({
  flyTierToTierId: (t: string) => t,
  tierIdToFlyTier: (t: string) => t,
}));
vi.mock('./CloudflareTunnelService', () => ({
  // Not configured → ensureServerTunnelConnector returns null immediately, so
  // the image-update + readiness path is exercised in isolation. The tunnel
  // recreate path is covered separately.
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
vi.mock('./ServerSessionService', () => ({ generateServerSessionToken: vi.fn() }));
vi.mock('@/lib/workspaceMfaEnforcement', () => ({ computeMfaEnforcement: vi.fn() }));

let ServerService: typeof import('./ServerService');

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

describe('restartRemoteServer — provider recreates machine under a new id (Docker)', () => {
  const dockerServer = {
    id: 'ws_docker',
    deploymentType: 'remote' as const,
    machineId: 'old_container_id',
    machineName: 'ws-docker',
    serverUrl: 'http://localhost:43365',
    tunnelId: 'tun_x',
    volumeId: 'vol_x',
    provider: 'docker',
    ownerId: 'user_x',
    status: 'online' as const,
  };

  function primeOwnerAndServer() {
    mockSelectSequence([
      { role: 'owner' },
      { role: 'owner', isAdmin: false },
      dockerServer, // restartRemoteServer's getServer
      dockerServer, // ensureServerTunnelConnector's getServer
    ]);
  }

  it('persists the new machine id and waits on it, not the removed one', async () => {
    primeOwnerAndServer();
    // Docker recreates the container → updateMachineImage yields a NEW id.
    providerMock.updateMachineImage.mockResolvedValue('new_container_id');
    providerMock.waitForState.mockResolvedValue(undefined);
    providerMock.waitForHealthy.mockResolvedValue(undefined);

    const result = await ServerService.updateRemoteServer('ws_docker', 'user_x');

    expect(result.success).toBe(true);

    // The image update ran against the id we had before the swap…
    expect(providerMock.updateMachineImage.mock.calls[0][0]).toBe('old_container_id');

    // …the NEW id was persisted to servers.machineId…
    expect(captured.some((c) => c.machineId === 'new_container_id')).toBe(true);

    // …and the readiness waits targeted the NEW (live) id, never the removed one.
    expect(providerMock.waitForState).toHaveBeenCalledTimes(1);
    expect(providerMock.waitForState.mock.calls[0][0]).toBe('new_container_id');
    expect(providerMock.waitForHealthy).toHaveBeenCalledTimes(1);
    expect(providerMock.waitForHealthy.mock.calls[0][0]).toBe('new_container_id');
  });

  it('does not rewrite machineId when the provider keeps the same id (Fly-style in-place update)', async () => {
    primeOwnerAndServer();
    // In-place providers return the SAME id they were given.
    providerMock.updateMachineImage.mockResolvedValue('old_container_id');
    providerMock.waitForState.mockResolvedValue(undefined);
    providerMock.waitForHealthy.mockResolvedValue(undefined);

    const result = await ServerService.updateRemoteServer('ws_docker', 'user_x');

    expect(result.success).toBe(true);
    expect(providerMock.waitForState.mock.calls[0][0]).toBe('old_container_id');
    // No machineId rewrite should be issued — only the final status update.
    expect(captured.some((c) => c.machineId !== undefined)).toBe(false);
  });
});
