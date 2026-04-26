/**
 * HttpServer community routes — unit tests using mocked services.
 *
 * Strategy: mock all service classes and the db module so tests run without
 * a live database. Service method mocks are shared across all instances of
 * each class so the instances created inside createHttpApp() are directly
 * controllable from the tests.
 */

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Hono } from 'hono';

// ============================================================================
// Hoisted mock state — vi.hoisted runs before vi.mock factories, so these
// variables are accessible in the factory closures and in test bodies.
// ============================================================================

const {
  mockAwardForCompletion,
  mockGrantBonus,
  mockReverseGrant,
  mockNotifList,
  mockMarkRead,
  mockMarkAllRead,
  mockUnreadCount,
  mockListMembers,
  mockGetMember,
} = vi.hoisted(() => ({
  mockAwardForCompletion: vi.fn(),
  mockGrantBonus: vi.fn(),
  mockReverseGrant: vi.fn(),
  mockNotifList: vi.fn(),
  mockMarkRead: vi.fn(),
  mockMarkAllRead: vi.fn(),
  mockUnreadCount: vi.fn(),
  mockListMembers: vi.fn(),
  mockGetMember: vi.fn(),
}));

// ============================================================================
// Mocks — must precede any import of the tested module
// ============================================================================

vi.mock('./oauth/index', () => ({ default: new Hono() }));

vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));

vi.mock('./services/ServerService', () => ({
  getServerByToken: vi.fn(),
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  gateServerAccess: vi.fn(),
  gateServerEdit: vi.fn(),
}));

vi.mock('./services/WidgetService', () => {
  class WidgetSettingsValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WidgetSettingsValidationError';
    }
  }
  return {
    authenticateWidget: vi.fn(),
    enableWidget: vi.fn(),
    disableWidget: vi.fn(),
    updateWidgetSettings: vi.fn(),
    WidgetSettingsValidationError,
  };
});

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

// Community services — use hoisted vi.fn() singletons so tests can configure
// the exact same function objects that the service instances inside createHttpApp use.
vi.mock('./services/CommunityPointsService', () => ({
  CommunityPointsService: class {
    awardForCompletion = mockAwardForCompletion;
    grantBonus = mockGrantBonus;
    reverseGrant = mockReverseGrant;
  },
}));

vi.mock('./services/CommunityNotificationService', () => ({
  CommunityNotificationService: class {
    list = mockNotifList;
    markRead = mockMarkRead;
    markAllRead = mockMarkAllRead;
    unreadCount = mockUnreadCount;
  },
}));

vi.mock('./services/CommunityLeaderboardService', () => ({
  CommunityLeaderboardService: class {
    listMembers = mockListMembers;
    getMember = mockGetMember;
  },
}));

// db — self-contained factory (vi.mock is hoisted; no outer variable refs allowed).
// We expose individually-resettable vi.fn() mocks accessible via dbMock below.
//
// Design: both `.where(...).limit(n)` and bare `await db.select().from().where()`
// need to resolve to arrays. We achieve this by making the object returned from
// .where() both: (a) have a .limit() method that resolves, AND (b) be a Promise
// (implements .then()) so that `await db.select().from().where(eq(...))` works.
// Tests that need custom resolution override `dbMock.select` per-test.
vi.mock('../db/index', () => {
  const makeWhereResult = (rows: unknown[] = []) => {
    const p: any = Promise.resolve(rows);
    p.limit = vi.fn().mockResolvedValue(rows);
    return p;
  };
  const makeFrom = () => ({ where: vi.fn(() => makeWhereResult()) });
  const makeSetChain = () => ({ where: vi.fn().mockResolvedValue([]) });
  const makeOnConflict = () => ({ onConflictDoNothing: vi.fn().mockResolvedValue([]) });
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => makeFrom()) })),
      update: vi.fn(() => ({ set: vi.fn(() => makeSetChain()) })),
      insert: vi.fn(() => ({ values: vi.fn(() => makeOnConflict()) })),
    },
  };
});

// Schema mock — column refs only need to be truthy unique objects.
vi.mock('../db/schema', () => {
  const col = (name: string) => ({ _colName: name });
  return {
    widgetProjects: {
      id: col('id'), slug: col('slug'), serverId: col('server_id'),
      apiKey: col('api_key'), apiSecretHash: col('api_secret_hash'),
      enabled: col('enabled'), isPublic: col('is_public'),
    },
    widgetUsers: {
      id: col('id'), projectId: col('project_id'), externalUserId: col('external_user_id'),
      name: col('name'), username: col('username'), avatarUrl: col('avatar_url'),
      status: col('status'), lastSeenAt: col('last_seen_at'),
    },
    widgetUserBalances: {
      widgetUserId: col('widget_user_id'), projectId: col('project_id'),
      balance: col('balance'), payoutsCount: col('payouts_count'), rank: col('rank'),
    },
    widgetUserNotifications: {
      id: col('id'), widgetUserId: col('widget_user_id'), projectId: col('project_id'),
      type: col('type'), payload: col('payload'), readAt: col('read_at'),
    },
    pointGrants: {
      id: col('id'), widgetUserId: col('widget_user_id'), projectId: col('project_id'),
    },
    users: { id: col('id'), email: col('email') },
    deviceCodes: {},
    servers: { id: col('id'), ownerId: col('owner_id') },
    serverTemplates: {},
    agentTemplates: {},
    systemSettings: { key: col('key'), value: col('value'), updatedAt: col('updated_at') },
    serverMembers: { serverId: col('server_id'), userId: col('user_id'), role: col('role'), isAdmin: col('is_admin') },
    subscriptions: {},
  };
});

// ============================================================================
// Imports (after vi.mock declarations)
// ============================================================================

import { createHttpApp } from './HttpServer';
import * as ServerService from './services/ServerService';
import * as WidgetService from './services/WidgetService';
import { extractUserIdFromToken } from './auth/jwt';
import { db } from '../db/index';

// ============================================================================
// Typed db handle for test setup
// ============================================================================

const dbMock = db as unknown as {
  select: MockInstance;
  update: MockInstance;
  insert: MockInstance;
};

// ============================================================================
// Test data
// ============================================================================

const mockServer = { id: 'server-1', ownerId: 'user-1' };
const mockProject = {
  id: 'proj-1', serverId: 'server-1', name: 'Test', slug: 'test',
  apiKey: 'ak', apiSecretHash: 'sh', enabled: true, isPublic: true,
};
const mockWidgetUser = { id: 'wu-1', projectId: 'proj-1', externalUserId: 'ext-1', name: 'Alice', status: 'active' };
const mockGrant = { id: 'grant-1', projectId: 'proj-1', widgetUserId: 'wu-1', amount: 50 };

// ============================================================================
// Helper utilities
// ============================================================================

const makeApp = () => createHttpApp();

async function post(app: ReturnType<typeof makeApp>, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function get(app: ReturnType<typeof makeApp>, path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { headers });
}

async function del(app: ReturnType<typeof makeApp>, path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { method: 'DELETE', headers });
}

const ADMIN_BEARER = 'Bearer admin-jwt';
const WIDGET_BEARER = 'Bearer widget-jwt';

/** Reset all hoisted community service mocks. */
function resetCommunityMocks() {
  mockAwardForCompletion.mockReset();
  mockGrantBonus.mockReset();
  mockReverseGrant.mockReset();
  mockNotifList.mockReset();
  mockMarkRead.mockReset();
  mockMarkAllRead.mockReset();
  mockUnreadCount.mockReset();
  mockListMembers.mockReset();
  mockGetMember.mockReset();
}

/**
 * Return a Promise-like object that resolves to `rows` and also has a
 * .limit() method. This mirrors what Drizzle's query builder returns — it's
 * both an awaitable and has chainable methods.
 */
function makeWhereResult(rows: unknown[] = []) {
  const p: any = Promise.resolve(rows);
  p.limit = vi.fn().mockResolvedValue(rows);
  return p;
}

/**
 * Configure dbMock.select() to return mockProject in the widgetProjects lookup
 * (the requireProjectAdmin helper's first db call), then an empty array for
 * any subsequent selects.
 */
function setupDbProjectLookup(project = mockProject) {
  dbMock.select.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(makeWhereResult([project])),
    }),
  }));
}

/**
 * Set up a valid project-admin authentication context.
 * extractUserIdFromToken → 'user-admin'
 * checkCloudOpPermission → true
 * db.select → returns mockProject for the widgetProjects lookup
 */
function setupAdmin(project = mockProject) {
  vi.mocked(extractUserIdFromToken).mockResolvedValue('user-admin');
  vi.mocked(ServerService.checkCloudOpPermission).mockResolvedValue(true);
  setupDbProjectLookup(project);
}

/**
 * Configure WidgetService.authenticateWidget to return a valid widget session.
 */
function setupWidgetSession(widgetUserId = 'wu-1', projectId = 'proj-1') {
  vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({
    projectId, projectSlug: 'test', widgetUserId, authenticated: true,
  });
}

// ============================================================================
// Task 7b: POST /api/server/community/events
// ============================================================================

describe('POST /api/server/community/events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetCommunityMocks();
    dbMock.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) }),
    });
    dbMock.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
  });

  it('401 when X-Server-Token is absent', async () => {
    const app = makeApp();
    const res = await post(app, '/api/server/community/events', { events: [] });
    expect(res.status).toBe(401);
  });

  it('401 when X-Server-Token is invalid', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(null as any);
    const app = makeApp();
    const res = await post(app, '/api/server/community/events', { events: [] }, { 'X-Server-Token': 'bad' });
    expect(res.status).toBe(401);
  });

  it('400 when body is malformed JSON', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    const app = makeApp();
    const res = await app.request('http://localhost/api/server/community/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Server-Token': 'tok' },
      body: '{{not-json',
    });
    expect(res.status).toBe(400);
  });

  it('400 when body.events is not an array', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    const app = makeApp();
    const res = await post(app, '/api/server/community/events', { events: 'wrong' }, { 'X-Server-Token': 'tok' });
    expect(res.status).toBe(400);
  });

  it('200 with todo.status_changed event — delegates to awardForCompletion', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    mockAwardForCompletion.mockResolvedValue({ applied: true, amount: 10 });

    const app = makeApp();
    const event = {
      type: 'todo.status_changed',
      payload: {
        ticketId: 'ticket-1', projectId: 'proj-1', sourceType: 'widget',
        externalUserId: 'ext-1', oldStatus: 'in_progress', newStatus: 'done',
        upvoteCountAtTransition: 0, selfUpvoted: false, occurredAt: new Date().toISOString(),
      },
    };
    const res = await post(app, '/api/server/community/events', { events: [event] }, { 'X-Server-Token': 'tok' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0]).toEqual({ idx: 0, ok: true });
    expect(mockAwardForCompletion).toHaveBeenCalledOnce();
  });

  it('200 with widget_user.interacted — upserts widget user via db', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) });
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    dbMock.insert.mockReturnValue({ values: insertValues });
    dbMock.update.mockReturnValue({ set: updateSet });

    const app = makeApp();
    const event = { type: 'widget_user.interacted', payload: { projectId: 'proj-1', externalUserId: 'ext-42', name: 'Bob' } };
    const res = await post(app, '/api/server/community/events', { events: [event] }, { 'X-Server-Token': 'tok' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0].ok).toBe(true);
    expect(dbMock.insert).toHaveBeenCalled();
    expect(dbMock.update).toHaveBeenCalled();
  });

  it('200 with unknown event type — records error at that index', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    const app = makeApp();
    const res = await post(app, '/api/server/community/events', { events: [{ type: 'bogus', payload: {} }] }, { 'X-Server-Token': 'tok' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/unknown event type/);
  });

  it('200 — service errors recorded per-event, rest still processes', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue(mockServer as any);
    mockAwardForCompletion.mockRejectedValueOnce(new Error('DB error')).mockResolvedValueOnce({ applied: true });

    const event1 = {
      type: 'todo.status_changed',
      payload: { ticketId: 't1', projectId: 'p1', sourceType: 'widget', externalUserId: 'e1', oldStatus: 'pending', newStatus: 'done', upvoteCountAtTransition: 0, selfUpvoted: false, occurredAt: new Date().toISOString() },
    };
    const event2 = { ...event1, payload: { ...event1.payload, ticketId: 't2' } };
    const app = makeApp();
    const res = await post(app, '/api/server/community/events', { events: [event1, event2] }, { 'X-Server-Token': 'tok' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toBe('DB error');
    expect(body.results[1].ok).toBe(true);
  });
});

// ============================================================================
// Task 8: Staff / project-admin routes
// ============================================================================

describe('GET /api/community/:projectId/members', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('401 without Authorization header', async () => {
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members');
    expect(res.status).toBe(401);
  });

  it('403 when user is not project admin', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('user-1');
    vi.mocked(ServerService.checkCloudOpPermission).mockResolvedValue(false);
    setupDbProjectLookup();
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(403);
  });

  it('404 when project does not exist', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('user-1');
    dbMock.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(makeWhereResult([])),
      }),
    });
    const app = makeApp();
    const res = await get(app, '/api/community/no-proj/members', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(404);
  });

  it('200 returns leaderboard from CommunityLeaderboardService', async () => {
    setupAdmin();
    mockListMembers.mockResolvedValue({ members: [{ widgetUserId: 'wu-1', balance: 100 }], nextCursor: null });
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.members).toHaveLength(1);
    expect(mockListMembers).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', sort: 'rank', limit: 50 }));
  });

  it('passes sort + limit + cursor query params to listMembers', async () => {
    setupAdmin();
    mockListMembers.mockResolvedValue({ members: [], nextCursor: null });
    const app = makeApp();
    await get(app, '/api/community/proj-1/members?sort=balance&limit=10&cursor=some-cursor', { Authorization: ADMIN_BEARER });
    expect(mockListMembers).toHaveBeenCalledWith(expect.objectContaining({ sort: 'balance', limit: 10, cursor: 'some-cursor' }));
  });
});

describe('GET /api/community/:projectId/members/:widgetUserId', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('401 without auth', async () => {
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1');
    expect(res.status).toBe(401);
  });

  it('200 returns member detail', async () => {
    setupAdmin();
    mockGetMember.mockResolvedValue({ widgetUserId: 'wu-1', balance: 50, recentGrants: [] });
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.widgetUserId).toBe('wu-1');
    expect(mockGetMember).toHaveBeenCalledWith({ projectId: 'proj-1', widgetUserId: 'wu-1' });
  });

  it('404 when service throws "Member not found"', async () => {
    setupAdmin();
    mockGetMember.mockRejectedValue(new Error('Member not found'));
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/community/:projectId/members/:widgetUserId/grants', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  const validGrantBody = { amount: 50, reason: 'great work', idempotencyKey: 'idem-1' };

  it('401 without auth', async () => {
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants', validGrantBody);
    expect(res.status).toBe(401);
  });

  it('400 when amount is 0', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      { ...validGrantBody, amount: 0 }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/non-zero integer/);
  });

  it('400 when amount is a float', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      { ...validGrantBody, amount: 10.5 }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });

  it('400 when |amount| > 10000', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      { ...validGrantBody, amount: -10001 }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });

  it('400 when reason is blank', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      { ...validGrantBody, reason: '   ' }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });

  it('400 when idempotencyKey is missing', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      { amount: 50, reason: 'good' }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/idempotencyKey/);
  });

  it('200 on success — returns grant result', async () => {
    setupAdmin();
    mockGrantBonus.mockResolvedValue({ grant: mockGrant, newBalance: { balance: 50 } });
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants',
      validGrantBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.grant.id).toBe('grant-1');
    expect(mockGrantBonus).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1', widgetUserId: 'wu-1', amount: 50, reason: 'great work', clientRequestId: 'idem-1',
    }));
  });

  it('idempotent — second call with same idempotencyKey returns same grant', async () => {
    setupAdmin();
    mockGrantBonus.mockResolvedValue({ grant: mockGrant, newBalance: { balance: 50 } });
    const app = makeApp();
    await post(app, '/api/community/proj-1/members/wu-1/grants', validGrantBody, { Authorization: ADMIN_BEARER });
    // reset admin setup for second call
    setupAdmin();
    const res2 = await post(app, '/api/community/proj-1/members/wu-1/grants', validGrantBody, { Authorization: ADMIN_BEARER });
    expect(res2.status).toBe(200);
    expect((await res2.json() as any).grant.id).toBe('grant-1');
  });

  it('400 when widget user does not belong to project', async () => {
    setupAdmin();
    mockGrantBonus.mockRejectedValue(new Error('Widget user does not belong to this project'));
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/members/wu-1/grants', validGrantBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/community/:projectId/grants/:grantId/reversals', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  const validBody = { reason: 'mistake', idempotencyKey: 'rev-k1' };

  it('401 without auth', async () => {
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals', validBody);
    expect(res.status).toBe(401);
  });

  it('400 when reason is blank', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals',
      { reason: '  ', idempotencyKey: 'k' }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });

  it('400 when idempotencyKey is missing', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals',
      { reason: 'x' }, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });

  it('200 on success — returns reversal', async () => {
    setupAdmin();
    mockReverseGrant.mockResolvedValue({ reversal: { id: 'rev-1', amount: -50 } });
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals', validBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reversal.id).toBe('rev-1');
    expect(mockReverseGrant).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1', grantId: 'grant-1', reason: 'mistake', clientRequestId: 'rev-k1',
    }));
  });

  it('400 when service throws "Cannot reverse a reversal"', async () => {
    setupAdmin();
    mockReverseGrant.mockRejectedValue(new Error('Cannot reverse a reversal'));
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals', validBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/reversal/);
  });

  it('404 when grant not found', async () => {
    setupAdmin();
    mockReverseGrant.mockRejectedValue(new Error('Grant not found'));
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals', validBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(404);
  });

  it('400 when grant belongs to a different project', async () => {
    setupAdmin();
    mockReverseGrant.mockRejectedValue(new Error('Grant does not belong to this project'));
    const app = makeApp();
    const res = await post(app, '/api/community/proj-1/grants/grant-1/reversals', validBody, { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/community/:projectId/members/:widgetUserId', () => {
  let setMock: MockInstance;
  let whereMock: MockInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    whereMock = vi.fn().mockResolvedValue([]);
    setMock = vi.fn().mockReturnValue({ where: whereMock });
    dbMock.update.mockReturnValue({ set: setMock });
  });

  it('401 without auth', async () => {
    const app = makeApp();
    const res = await del(app, '/api/community/proj-1/members/wu-1');
    expect(res.status).toBe(401);
  });

  it('200 and soft-deletes: sets status=deleted, name=[deleted user], username=null, avatarUrl=null', async () => {
    setupAdmin();
    const app = makeApp();
    const res = await del(app, '/api/community/proj-1/members/wu-1', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    // Verify the exact payload passed to db.update().set(...)
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'deleted',
      name: '[deleted user]',
      username: null,
      avatarUrl: null,
    }));
  });
});

describe('GET /api/community/:projectId/members/:widgetUserId/export', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('403 when neither admin nor the member themselves', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue('user-other');
    vi.mocked(ServerService.checkCloudOpPermission).mockResolvedValue(false);
    setupDbProjectLookup();
    // Widget user is different from requested widgetUserId
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({
      projectId: 'proj-1', projectSlug: 'test', widgetUserId: 'wu-DIFFERENT', authenticated: true,
    });
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1/export', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(403);
  });

  it('200 for a project admin — returns member + grants + notifications', async () => {
    setupAdmin();
    // After admin auth passes, subsequent selects are for widgetUsers, pointGrants, notifications
    let callCount = 0;
    dbMock.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // widgetProjects lookup in requireProjectAdmin
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(makeWhereResult([mockProject])) }) };
      }
      if (callCount === 2) {
        // widgetUsers lookup — no .limit(), so where() must be thenable
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(makeWhereResult([mockWidgetUser])) }) };
      }
      // pointGrants + notifications → empty
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(makeWhereResult([])) }) };
    });

    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1/export', { Authorization: ADMIN_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.member.id).toBe('wu-1');
    expect(Array.isArray(body.grants)).toBe(true);
    expect(Array.isArray(body.notifications)).toBe(true);
  });

  it('403 for a different widget user requesting another user\'s export', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue(null);
    vi.mocked(ServerService.checkCloudOpPermission).mockResolvedValue(false);
    setupDbProjectLookup();
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({
      projectId: 'proj-1', projectSlug: 'test', widgetUserId: 'wu-ATTACKER', authenticated: true,
    });
    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1/export', { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(403);
  });

  it('200 for the widget user accessing their own data', async () => {
    // No valid admin JWT — requireProjectAdmin throws CommunityAuthError(401) early
    // (before hitting db.select for the project lookup), so authenticateWidget is
    // tried next. The widget user IS the subject → authorized = true.
    vi.mocked(extractUserIdFromToken).mockResolvedValue(null);
    vi.mocked(ServerService.checkCloudOpPermission).mockResolvedValue(false);

    // requireProjectAdmin throws immediately (no userId) → no db.select call there.
    // The first actual db.select is the widgetUsers lookup inside the route.
    let callCount = 0;
    dbMock.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // widgetUsers lookup — bare await (no .limit())
        return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(makeWhereResult([mockWidgetUser])) }) };
      }
      // pointGrants + notifications → empty
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(makeWhereResult([])) }) };
    });

    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({
      projectId: 'proj-1', projectSlug: 'test', widgetUserId: 'wu-1', authenticated: true,
    });

    const app = makeApp();
    const res = await get(app, '/api/community/proj-1/members/wu-1/export', { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.member.id).toBe('wu-1');
  });
});

// ============================================================================
// Task 9: Widget community routes
// ============================================================================

describe('GET /api/widget/me/community', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetCommunityMocks();
    // Default: both balance query and count query return empty arrays.
    // makeWhereResult provides both .limit() and Promise resolution.
    dbMock.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(makeWhereResult([])),
      }),
    });
    mockUnreadCount.mockResolvedValue(0);
  });

  it('401 when authenticateWidget returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null);
    const app = makeApp();
    const res = await get(app, '/api/widget/me/community', { Authorization: 'Bearer x' });
    expect(res.status).toBe(401);
  });

  it('401 when auth has no widgetUserId (anonymous project key)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({
      projectId: 'proj-1', projectSlug: 'test', authenticated: false,
    });
    const app = makeApp();
    const res = await get(app, '/api/widget/me/community', { Authorization: 'Bearer proj-key' });
    expect(res.status).toBe(401);
  });

  it('200 returns balance/rank/totalMembers/unreadCount', async () => {
    setupWidgetSession();
    mockUnreadCount.mockResolvedValue(3);

    let callCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // widgetUserBalances — uses .limit(1)
            return makeWhereResult([{ balance: 100, payoutsCount: 2, rank: 5 }]);
          }
          // active member count — bare await (no .limit())
          return makeWhereResult([{ totalMembers: 10 }]);
        }),
      }),
    }));

    const app = makeApp();
    const res = await get(app, '/api/widget/me/community', { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.balance).toBe(100);
    expect(body.rank).toBe(5);
    expect(body.payoutsCount).toBe(2);
    expect(body.unreadNotificationCount).toBe(3);
  });

  it('returns zero defaults when no balance row exists', async () => {
    setupWidgetSession();
    mockUnreadCount.mockResolvedValue(0);

    let callCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return makeWhereResult([]); // no balance row
          }
          return makeWhereResult([{ totalMembers: 0 }]);
        }),
      }),
    }));

    const app = makeApp();
    const res = await get(app, '/api/widget/me/community', { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.balance).toBe(0);
    expect(body.rank).toBeNull();
    expect(body.payoutsCount).toBe(0);
  });
});

describe('GET /api/widget/notifications', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('401 when unauthenticated', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null);
    const app = makeApp();
    const res = await get(app, '/api/widget/notifications');
    expect(res.status).toBe(401);
  });

  it('200 returns paginated notifications newest-first', async () => {
    setupWidgetSession();
    mockNotifList.mockResolvedValue({ notifications: [{ id: 'n1' }, { id: 'n2' }], nextCursor: null });
    const app = makeApp();
    const res = await get(app, '/api/widget/notifications', { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications[0].id).toBe('n1');
    expect(mockNotifList).toHaveBeenCalledWith(expect.objectContaining({ widgetUserId: 'wu-1', limit: 25 }));
  });

  it('respects limit and cursor query params', async () => {
    setupWidgetSession();
    mockNotifList.mockResolvedValue({ notifications: [], nextCursor: null });
    const app = makeApp();
    await get(app, '/api/widget/notifications?limit=10&cursor=2026-01-01T00:00:00.000Z', { Authorization: WIDGET_BEARER });
    expect(mockNotifList).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10, cursor: '2026-01-01T00:00:00.000Z',
    }));
  });
});

describe('POST /api/widget/notifications/:id/read', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('401 when unauthenticated', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null);
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/n1/read', undefined);
    expect(res.status).toBe(401);
  });

  it('200 and marks notification as read', async () => {
    setupWidgetSession();
    mockMarkRead.mockResolvedValue(undefined);
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/n1/read', undefined, { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
    expect(mockMarkRead).toHaveBeenCalledWith({ widgetUserId: 'wu-1', notificationId: 'n1' });
  });

  it('404 when notification not found', async () => {
    setupWidgetSession();
    mockMarkRead.mockRejectedValue(new Error('Notification not found'));
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/n1/read', undefined, { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(404);
  });

  it('403 when notification belongs to a different user', async () => {
    setupWidgetSession();
    mockMarkRead.mockRejectedValue(new Error('Forbidden'));
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/n1/read', undefined, { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/widget/notifications/read-all', () => {
  beforeEach(() => { vi.resetAllMocks(); resetCommunityMocks(); });

  it('401 when unauthenticated', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null);
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/read-all', undefined);
    expect(res.status).toBe(401);
  });

  it('200 returns markAllRead result with markedCount', async () => {
    setupWidgetSession();
    mockMarkAllRead.mockResolvedValue({ markedCount: 7 });
    const app = makeApp();
    const res = await post(app, '/api/widget/notifications/read-all', undefined, { Authorization: WIDGET_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.markedCount).toBe(7);
    expect(mockMarkAllRead).toHaveBeenCalledWith({ widgetUserId: 'wu-1' });
  });
});
