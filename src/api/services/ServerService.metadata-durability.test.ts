/**
 * Server-metadata durability tests.
 *
 * These tests lock in the single invariant that prevents the class of bug
 * where live, healthy user servers get silently disconnected from their DB
 * rows and stranded:
 *
 *   Destructive writes to servers.{machineId, machineName, serverUrl,
 *   tunnelToken, volumeId} must NOT happen as a side effect of a failed
 *   wake or a failed reprovision / tier change / region change. Those
 *   columns may only be rewritten atomically by provisionNewMachine after
 *   the replacement machine is up and healthy, or cleared by an explicit
 *   admin action.
 *
 * Historically the opposite was true: any error whose raw message contained
 * "404" or "not found" nuked machine_id, and the reprovision path pre-wiped
 * the whole metadata block before even attempting to create a new machine.
 * A transient Fly API blip therefore produced a permanent orphan. Real
 * incident: 2026-04-24 `ws_mo5raq4b_x4l5ek` (Bluesky) — machine was healthy
 * and serving throughout, DB row was zeroed, UI stuck "Setting up your
 * server..." forever.
 *
 * Each test captures every `db.update(servers).set(...)` payload made during
 * the call under test and asserts on the set of keys written. A failing
 * assertion here means someone reintroduced the destructive pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — capture every UPDATE ... SET payload written to the `servers` table
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
  // Schema column refs are only used by drizzle's query builder inside the
  // real db layer. For tests they just need to be truthy unique values so
  // `eq(servers.id, serverId)` returns something non-null.
  const col = (name: string) => ({ _colName: name });
  return {
    servers: { id: col('id') },
    serverMembers: { serverId: col('server_id'), userId: col('user_id'), role: col('role') },
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

// --- Provider mock. The test suite swaps its behaviour per scenario. -------

const providerMock = {
  getMachineState: vi.fn(),
  createMachine: vi.fn(),
  waitForState: vi.fn(),
  waitForHealthy: vi.fn(),
  startMachine: vi.fn(),
  stopMachine: vi.fn(),
  deleteMachine: vi.fn(),
  getRegions: vi.fn(() => [{ id: 'iad' }, { id: 'ams' }]),
  getTierSpecs: vi.fn(() => [{ tierId: 'perf-2x-8gb', diskGb: 60 }]),
  getVolume: vi.fn(async () => ({ sizeGb: 60 })),
  forkVolume: vi.fn(async () => ({ id: 'vol-forked' })),
  extendVolume: vi.fn(),
  deleteVolume: vi.fn(),
  createSnapshot: vi.fn(async () => ({ id: 'snap' })),
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

// --- Other ServerService dependencies (minimal stubs) ----------------------

vi.mock('./CloudflareTunnelService', () => ({
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

// Destructive columns: writing any of these to NULL during a request-path
// operation is the regression we're guarding against.
const DESTRUCTIVE_COLUMNS = ['machineId', 'machineName', 'serverUrl', 'tunnelToken', 'volumeId'] as const;

function assertNoDestructiveWipe(payloads: UpdatePayload[]) {
  for (const payload of payloads) {
    for (const col of DESTRUCTIVE_COLUMNS) {
      if (col in payload && payload[col] === null) {
        throw new Error(
          `Regression: UPDATE wrote ${col}=NULL during the operation. ` +
          `This is exactly the destructive wipe pattern that silently orphaned ` +
          `live machines. Full payload: ${JSON.stringify(payload)}`,
        );
      }
    }
  }
}

beforeEach(async () => {
  captured.length = 0;
  vi.clearAllMocks();
  // Fresh import so provider & db mocks are bound to the ServerService closure.
  vi.resetModules();
  ServerService = await import('./ServerService');

  // Default provider membership check: owner permission granted (the real
  // checkServerPermission hits the DB; we don't care about that surface for
  // these tests, just the write paths it gates).
  dbMock.query.servers.findFirst.mockImplementation(async () => undefined);
});

// ===========================================================================
// 1. wakeRemoteServerInternal — transient provider errors must NOT mutate DB
// ===========================================================================

describe('wakeRemoteServerInternal — DB durability on provider errors', () => {
  const liveServer = {
    id: 'ws_test',
    deploymentType: 'remote' as const,
    machineId: 'mach_test',
    serverUrl: 'https://fishtank-workspaces.fly.dev',
    tunnelId: 'tun_test',
    volumeId: 'vol_test',
    provider: 'fly',
    status: 'online' as const,
  };

  it('leaves DB untouched when provider throws an error whose message contains "404"', async () => {
    providerMock.getMachineState.mockRejectedValueOnce(new Error('fetch failed: 404 Not Found'));

    const result = await ServerService.wakeRemoteServerInternal(liveServer as any);

    expect(result.success).toBe(false);
    // Zero UPDATE statements should have been issued.
    expect(captured).toHaveLength(0);
    assertNoDestructiveWipe(captured);
  });

  it('leaves DB untouched when provider throws any generic error containing "not found"', async () => {
    providerMock.getMachineState.mockRejectedValueOnce(new Error('upstream proxy: resource not found'));

    const result = await ServerService.wakeRemoteServerInternal(liveServer as any);

    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('leaves DB untouched when provider reports state="destroyed"', async () => {
    providerMock.getMachineState.mockResolvedValueOnce('destroyed');

    const result = await ServerService.wakeRemoteServerInternal(liveServer as any);

    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
    assertNoDestructiveWipe(captured);
  });
});

// ===========================================================================
// 2. reprovisionRemoteServer — failed provision must NOT leave a wiped DB row
// ===========================================================================

describe('reprovisionRemoteServer — metadata durability on provision failure', () => {
  it('never writes NULL to machineId/serverUrl/machineName/tunnelToken even when provisionNewMachine throws', async () => {
    // Server has no live machine (the precondition for reprovision).
    const priorServer = {
      id: 'ws_test',
      deploymentType: 'remote' as const,
      machineId: null,
      serverUrl: null,
      tunnelId: 'tun_test',
      volumeId: 'vol_test',
      region: 'iad',
      tier: 'perf-2x-8gb',
      autoSuspendEnabled: true,
      provider: 'fly',
      ownerId: 'user_test',
      status: 'offline' as const,
    };
    dbMock.query.servers.findFirst.mockResolvedValueOnce(priorServer);
    // Owner permission check: make it pass. checkServerPermission reads
    // server_members via the drizzle query builder; stub a positive result
    // by making db.select resolve to [{ role: 'owner' }].
    (dbMock as any).select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ role: 'owner' }]),
        })),
      })),
    }));

    // Provisioning fails for whatever reason (Cloudflare throttle, Fly quota, etc.)
    providerMock.createMachine.mockRejectedValueOnce(new Error('createMachine failed'));

    const result = await ServerService.reprovisionRemoteServer('ws_test', 'user_test');

    expect(result.success).toBe(false);
    assertNoDestructiveWipe(captured);
    // Specifically: no UPDATE should have set machineId=null during this call.
    for (const payload of captured) {
      expect(payload).not.toHaveProperty('machineId');
      expect(payload).not.toHaveProperty('serverUrl');
      expect(payload).not.toHaveProperty('machineName');
      expect(payload).not.toHaveProperty('tunnelToken');
    }
  });
});

// ===========================================================================
// 3. changeTier — failed tier change must not strand the row with NULLs
// ===========================================================================

describe('changeTier — metadata durability on tier-change failure', () => {
  it('never writes NULL machineId/serverUrl/machineName when provisionNewMachine throws after old machine deletion', async () => {
    const priorServer = {
      id: 'ws_test',
      deploymentType: 'remote' as const,
      machineId: 'mach_old',
      machineName: 'srv-old',
      serverUrl: 'https://fishtank-workspaces.fly.dev',
      tunnelId: 'tun_test',
      volumeId: 'vol_test',
      region: 'iad',
      tier: 'shared-4x-4gb',
      autoSuspendEnabled: true,
      provider: 'fly',
      ownerId: 'user_test',
      status: 'online' as const,
    };
    dbMock.query.servers.findFirst.mockResolvedValueOnce(priorServer);
    (dbMock as any).select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ role: 'owner' }]),
        })),
      })),
    }));

    // Simulate: stop + delete old machine succeed; volume inspection succeeds;
    // but creating the new machine throws.
    providerMock.getVolume.mockResolvedValueOnce({ sizeGb: 60 });
    providerMock.createMachine.mockRejectedValueOnce(new Error('Fly quota exceeded'));

    const result = await ServerService.changeTier('ws_test', 'user_test', 'perf-2x-8gb' as any);

    expect(result.success).toBe(false);
    assertNoDestructiveWipe(captured);
    for (const payload of captured) {
      expect(payload).not.toHaveProperty('machineId');
      expect(payload).not.toHaveProperty('serverUrl');
      expect(payload).not.toHaveProperty('machineName');
      expect(payload).not.toHaveProperty('tunnelToken');
    }
  });
});

// ===========================================================================
// 4. changeRegion — failed region change leaves metadata intact for recovery
// ===========================================================================

describe('changeRegion — metadata durability on region-change failure', () => {
  it('never writes NULL machineId/serverUrl/volumeId when provisionNewMachine throws', async () => {
    const priorServer = {
      id: 'ws_test',
      deploymentType: 'remote' as const,
      machineId: 'mach_old',
      machineName: 'srv-old',
      serverUrl: 'https://fishtank-workspaces.fly.dev',
      tunnelId: 'tun_test',
      volumeId: 'vol_old',
      region: 'iad',
      tier: 'perf-2x-8gb',
      autoSuspendEnabled: true,
      provider: 'fly',
      ownerId: 'user_test',
      status: 'online' as const,
    };
    dbMock.query.servers.findFirst.mockResolvedValueOnce(priorServer);
    (dbMock as any).select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ role: 'owner' }]),
        })),
      })),
    }));

    providerMock.forkVolume.mockResolvedValueOnce({ id: 'vol_new' });
    providerMock.createMachine.mockRejectedValueOnce(new Error('createMachine failed'));

    const result = await ServerService.changeRegion('ws_test', 'user_test', 'ams');

    expect(result.success).toBe(false);
    assertNoDestructiveWipe(captured);
    for (const payload of captured) {
      expect(payload).not.toHaveProperty('machineId');
      expect(payload).not.toHaveProperty('serverUrl');
      expect(payload).not.toHaveProperty('machineName');
      expect(payload).not.toHaveProperty('volumeId');
      expect(payload).not.toHaveProperty('tunnelToken');
    }
  });
});
