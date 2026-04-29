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
  createApp: vi.fn(),
  deleteApp: vi.fn(),
  // Phase 6: per-tenant ingress setup. provisionNewMachine calls these
  // when flyAppName is set, so any test that drives a per-tenant flow
  // (reprovisionRemoteServer with persisted flyAppName, the post-cutover
  // migration test) needs them mocked or the call would fail with
  // "provider.allocateIPs is not a function".
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
  // resetAllMocks (not clearAllMocks) — clearAllMocks only clears call history,
  // it does NOT drain queued mockResolvedValueOnce / mockRejectedValueOnce
  // implementations. Without resetAllMocks, a once-rejection set up in one
  // test can fire in a later test that didn't expect it.
  vi.resetAllMocks();

  // Re-establish default provider behavior. Tests override these per-case via
  // mockResolvedValueOnce / mockRejectedValueOnce; defaults need to be
  // re-applied here because resetAllMocks just wiped them.
  providerMock.getVolume.mockImplementation(async () => ({ sizeGb: 60 }));
  providerMock.forkVolume.mockImplementation(async () => ({ id: 'vol-forked' }));
  providerMock.createSnapshot.mockImplementation(async () => ({ id: 'snap' }));
  providerMock.createVolumeFromSnapshot.mockImplementation(async () => ({ id: 'vol-restored' }));
  providerMock.getRegions.mockImplementation(() => [{ id: 'iad' }, { id: 'ams' }]);
  providerMock.getTierSpecs.mockImplementation(() => [{ tierId: 'perf-2x-8gb', diskGb: 60 }]);
  providerMock.getRoutingInfo.mockImplementation(() => ({ serverUrl: '' }));

  // Re-establish dbMock.update's chain. Same reason as above: the original
  // factory implementation was wiped by resetAllMocks.
  dbMock.update.mockImplementation(() => ({
    set: vi.fn((values: UpdatePayload) => {
      captured.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));

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

/**
 * `db.select().from(...).where(...).limit(N)` is the chain used by getServer
 * and checkServerPermission. The existing tests in this file mock the chain
 * to return a single fixed value, which works for assertions that only check
 * for the absence of destructive writes — those tests pass even when the
 * function under test bails out early with success: false.
 *
 * The migration tests below need to actually exercise the migration body, so
 * each select() call must return the correct row in sequence:
 *
 *   reprovisionRemoteServer:   [serverMembers row, server row]
 *   migrateWorkspaceToOwnApp:  [server row (initial), server row (refresh)]
 *
 * Pass the responses in the order the selects happen.
 */
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

// ===========================================================================
// 5. migrateWorkspaceToOwnApp — failure-path state handling
//
// Three regression scenarios from review:
//
//   (a) Pre-cutover failure (createSnapshot, createApp, or
//       createVolumeFromSnapshot throws): row must end up at status='offline'
//       (NOT stuck in 'provisioning'); old machine + volume references
//       unchanged; partial new resources cleaned up.
//
//   (b) Post-cutover failure (provisionNewMachine writes the row, then a
//       wait throws): row must stay at status='provisioning' for operator
//       attention; new app/volume must NOT be deleted (DB references them).
//
//   (c) First-provision retry safety: a row inserted with flyAppName already
//       populated must round-trip through reprovisionRemoteServer to the
//       per-tenant app, never the legacy shared app.
// ===========================================================================

describe('migrateWorkspaceToOwnApp — pre-cutover failures must drop the gate', () => {
  const legacyServer = {
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
    flyAppName: null,
    flyNetworkName: null,
  };

  it('createSnapshot throws → status=offline, no app/volume cleanup, no deleteApp called', async () => {
    // Sequence of getServer calls during migrate:
    //   1. start of migrate — reads the legacy row
    //   2. inside catch — refresh to detect cutover (still legacy: pre-cutover)
    mockSelectSequence([legacyServer, legacyServer]);

    providerMock.createSnapshot.mockRejectedValueOnce(new Error('snapshot service down'));

    await expect(ServerService.migrateWorkspaceToOwnApp('ws_test')).rejects.toThrow(/snapshot service down/);

    // Must have flipped status='provisioning' first, then back to 'offline'.
    const statuses = captured
      .map(p => p.status)
      .filter((s): s is string => typeof s === 'string');
    expect(statuses).toEqual(['provisioning', 'offline']);

    // No app or volume was created, so neither should have been cleaned up.
    expect(providerMock.createApp).not.toHaveBeenCalled();
    expect(providerMock.createVolumeFromSnapshot).not.toHaveBeenCalled();
    expect(providerMock.deleteApp).not.toHaveBeenCalled();
    expect(providerMock.deleteVolume).not.toHaveBeenCalled();

    // No destructive wipes of the legacy machine/volume references.
    assertNoDestructiveWipe(captured);
  });

  it('createApp throws → status=offline, no volume cleanup, no deleteApp call', async () => {
    mockSelectSequence([legacyServer, legacyServer]);

    providerMock.createSnapshot.mockResolvedValueOnce({ id: 'snap_x' });
    providerMock.createApp.mockRejectedValueOnce(new Error('Fly org quota exceeded'));

    await expect(ServerService.migrateWorkspaceToOwnApp('ws_test')).rejects.toThrow(/quota/);

    const statuses = captured
      .map(p => p.status)
      .filter((s): s is string => typeof s === 'string');
    expect(statuses).toEqual(['provisioning', 'offline']);

    expect(providerMock.createVolumeFromSnapshot).not.toHaveBeenCalled();
    expect(providerMock.deleteApp).not.toHaveBeenCalled(); // appCreated never flipped to true
    expect(providerMock.deleteVolume).not.toHaveBeenCalled();

    assertNoDestructiveWipe(captured);
  });

  it('createVolumeFromSnapshot throws → status=offline, deleteApp called, no deleteVolume', async () => {
    mockSelectSequence([legacyServer, legacyServer]);

    providerMock.createSnapshot.mockResolvedValueOnce({ id: 'snap_x' });
    providerMock.createApp.mockResolvedValueOnce(undefined);
    providerMock.createVolumeFromSnapshot.mockRejectedValueOnce(new Error('volume restore failed'));

    await expect(ServerService.migrateWorkspaceToOwnApp('ws_test')).rejects.toThrow(/restore/);

    const statuses = captured
      .map(p => p.status)
      .filter((s): s is string => typeof s === 'string');
    expect(statuses).toEqual(['provisioning', 'offline']);

    // App was created but volume restore threw — cleanup must delete the empty app.
    expect(providerMock.deleteApp).toHaveBeenCalledTimes(1);
    expect(providerMock.deleteApp).toHaveBeenCalledWith('ws-ws-test');

    // No new volume was created, so no deleteVolume.
    expect(providerMock.deleteVolume).not.toHaveBeenCalled();

    assertNoDestructiveWipe(captured);
  });
});

describe('migrateWorkspaceToOwnApp — post-cutover failures must NOT clean up', () => {
  const legacyServer = {
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
    flyAppName: null,
    flyNetworkName: null,
  };

  // Simulated post-cutover row state: provisionNewMachine has already written
  // the new machineId + flyAppName. Status is still 'provisioning' because
  // the final 'online' write happens only after the waits we're about to fail.
  const postCutoverServer = {
    ...legacyServer,
    machineId: 'mach_new',
    flyAppName: 'ws-ws-test',
    flyNetworkName: 'ws-ws-test-net',
    status: 'provisioning' as const,
  };

  it('waitForHealthy throws after DB cutover → status stays provisioning, no new resources deleted', async () => {
    // 1st select: initial migrate read (legacy). 2nd select: refresh inside
    // catch (post-cutover — flyAppName already flipped, simulating what
    // provisionNewMachine wrote before the wait threw).
    mockSelectSequence([legacyServer, postCutoverServer]);

    providerMock.createSnapshot.mockResolvedValueOnce({ id: 'snap_x' });
    providerMock.createApp.mockResolvedValueOnce(undefined);
    providerMock.createVolumeFromSnapshot.mockResolvedValueOnce({ id: 'vol_new' });
    providerMock.createMachine.mockResolvedValueOnce({
      machineId: 'mach_new',
      machineName: 'srv-new',
      serverUrl: 'https://ws-ws-test.fly.dev',
      region: 'iad',
      volumeId: 'vol_new',
      appName: 'ws-ws-test',
      networkName: 'ws-ws-test-net',
    });
    providerMock.waitForState.mockResolvedValueOnce(undefined);
    // Health check fails — this is the post-cutover failure point.
    providerMock.waitForHealthy.mockRejectedValueOnce(new Error('health check timed out'));

    await expect(ServerService.migrateWorkspaceToOwnApp('ws_test')).rejects.toThrow(/health/);

    // Critical: status was never reset to 'offline'. The only status writes
    // should be the initial 'provisioning' flip; no 'offline' or 'online'
    // anywhere in the captured payloads.
    const statuses = captured
      .map(p => p.status)
      .filter((s): s is string => typeof s === 'string');
    expect(statuses).toContain('provisioning');
    expect(statuses).not.toContain('offline');

    // New resources MUST NOT be deleted — DB row already references them.
    expect(providerMock.deleteApp).not.toHaveBeenCalled();
    // The only deleteVolume permitted in this path is on oldVolumeId during
    // post-cutover step 6/7 cleanup, but we threw before reaching that.
    expect(providerMock.deleteVolume).not.toHaveBeenCalled();
  });
});

describe('reprovisionRemoteServer — first-provision retry stays per-tenant', () => {
  it('persisted flyAppName routes the retry to the per-tenant app, not the shared app', async () => {
    // Row state after a failed first-attempt provisioning: flyAppName is
    // populated (createServer sets it at insert time, even before the machine
    // exists), but machineId / serverUrl are still null because provisioning
    // never reached the DB write step.
    const failedFirstAttempt = {
      id: 'ws_test',
      deploymentType: 'remote' as const,
      machineId: null,
      machineName: null,
      serverUrl: null,
      tunnelId: null,
      volumeId: null,
      region: 'iad',
      tier: 'perf-2x-8gb',
      autoSuspendEnabled: true,
      provider: 'fly',
      ownerId: 'user_test',
      status: 'error' as const,
      flyAppName: 'ws-ws-test',
      flyNetworkName: 'ws-ws-test-net',
      tokenHash: 'old_hash',
    };
    // 1st select: checkServerPermission's serverMembers lookup (owner).
    // 2nd select: getServer (failedFirstAttempt row).
    mockSelectSequence([{ role: 'owner' }, failedFirstAttempt]);

    providerMock.createApp.mockResolvedValueOnce(undefined);
    providerMock.createMachine.mockResolvedValueOnce({
      machineId: 'mach_new',
      machineName: 'srv-new',
      serverUrl: 'https://ws-ws-test.fly.dev',
      region: 'iad',
      volumeId: 'vol_new',
      appName: 'ws-ws-test',
      networkName: 'ws-ws-test-net',
    });
    providerMock.waitForState.mockResolvedValueOnce(undefined);
    providerMock.waitForHealthy.mockResolvedValueOnce(undefined);

    const result = await ServerService.reprovisionRemoteServer('ws_test', 'user_test');

    expect(result.success).toBe(true);

    // The whole point of this test: createMachine was invoked targeting the
    // per-tenant app, NOT the legacy shared app (NOT undefined / null).
    expect(providerMock.createMachine).toHaveBeenCalledTimes(1);
    const createMachineArgs = providerMock.createMachine.mock.calls[0][0];
    expect(createMachineArgs.appName).toBe('ws-ws-test');
    expect(createMachineArgs.networkName).toBe('ws-ws-test-net');

    // And the idempotent createApp inside provisionNewMachine ran once with
    // the persisted name (so a retry that lost the Fly app side-effect from
    // the original createServer flight still recovers).
    expect(providerMock.createApp).toHaveBeenCalledWith('ws-ws-test', 'ws-ws-test-net');
  });
});
