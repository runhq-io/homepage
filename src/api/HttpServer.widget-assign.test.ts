import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  serverTokenFetch: vi.fn(),
}));

vi.mock('./services/WidgetService', () => ({
  authenticateWidget: vi.fn(),
  listExposedAgents: vi.fn(),
  getWidgetProjectRateLimit: vi.fn(),
  getWidgetUserAuditInfo: vi.fn(),
  assignAgent: vi.fn(),
  WidgetAssignError: class WidgetAssignError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, cause?: unknown) {
      super(code);
      this.name = 'WidgetAssignError';
      this.code = code;
      this.status = status;
    }
  },
  // Other exports referenced by HttpServer widget routes
  suggestAssignment: vi.fn(),
  listPublicProjects: vi.fn(),
}));

vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: {
    check: vi.fn(),
  },
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import { widgetRateLimiter } from './services/WidgetRateLimiter';

const makeApp = () => createHttpApp();

const AUTHED_WITH_ASSIGN = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  widgetUserId: 'wu-123',
  authenticated: true,
  permissions: new Set<string>(['assign_agent']),
  matchedRoles: ['triager'],
};

const VALID_BODY = JSON.stringify({ agentId: 'agent-99', command: 'Fix this issue' });

const postAssign = (
  app: ReturnType<typeof makeApp>,
  ticketId = 'ticket-abc',
  body: string | null = VALID_BODY,
) =>
  app.request(`/api/widget/tickets/${ticketId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== null ? { body } : {}),
  });

describe('POST /api/widget/tickets/:id/assign', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default happy-path stubs; individual tests override as needed.
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.listExposedAgents as any).mockResolvedValue([{ id: 'agent-99', name: 'Agent 99', description: null }]);
    (WidgetService.getWidgetProjectRateLimit as any).mockResolvedValue(30);
    (widgetRateLimiter.check as any).mockReturnValue({ allowed: true, retryAfterSec: 0 });
    (WidgetService.getWidgetUserAuditInfo as any).mockResolvedValue({ externalUserId: 'ext-user-1', name: 'Alice' });
    (WidgetService.assignAgent as any).mockResolvedValue({ jobId: 'job-001' });
  });

  it('401 when authenticateWidget returns null', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('403 when permissions does not include assign_agent', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      ...AUTHED_WITH_ASSIGN,
      permissions: new Set<string>(),
      matchedRoles: [],
    });
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('401 when widgetUserId is absent (anonymous / raw-key auth)', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      ...AUTHED_WITH_ASSIGN,
      widgetUserId: undefined,
    });
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Identified user required');
  });

  it('400 when body lacks agentId', async () => {
    const app = makeApp();
    const res = await postAssign(app, 'ticket-abc', JSON.stringify({ command: 'Do it' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('agentId and command required');
  });

  it('400 when body lacks command', async () => {
    const app = makeApp();
    const res = await postAssign(app, 'ticket-abc', JSON.stringify({ agentId: 'agent-99' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('agentId and command required');
  });

  it('400 when body is not valid JSON', async () => {
    const app = makeApp();
    const res = await postAssign(app, 'ticket-abc', 'not-json');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('agentId and command required');
  });

  it('403 when agentId not in listExposedAgents result', async () => {
    (WidgetService.listExposedAgents as any).mockResolvedValue([{ id: 'other-agent', name: 'Other', description: null }]);
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Agent not available');
  });

  it('429 when rate limiter denies; Retry-After header set', async () => {
    (widgetRateLimiter.check as any).mockReturnValue({ allowed: false, retryAfterSec: 120 });
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('120');
    const body = await res.json();
    expect(body.error).toBe('Rate limit exceeded');
  });

  it('404 when widget user lookup misses', async () => {
    (WidgetService.getWidgetUserAuditInfo as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Widget user not found');
  });

  it('200 happy path; assignAgent called with correct args', async () => {
    const app = makeApp();
    const res = await postAssign(app, 'ticket-abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ jobId: 'job-001', agentId: 'agent-99' });
    expect(WidgetService.assignAgent).toHaveBeenCalledWith(
      'proj-1',
      'ticket-abc',
      {
        agentId: 'agent-99',
        command: 'Fix this issue',
        actor: {
          widgetUserId: 'wu-123',
          externalUserId: 'ext-user-1',
          name: 'Alice',
          matchedRoles: ['triager'],
        },
      },
    );
  });

  it('503 when assignAgent throws WidgetAssignError workspace_unreachable', async () => {
    const { WidgetAssignError } = await import('./services/WidgetService');
    (WidgetService.assignAgent as any).mockRejectedValue(
      new (WidgetAssignError as any)('workspace_unreachable', 503),
    );
    const app = makeApp();
    const res = await postAssign(app);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('workspace_unreachable');
  });

  it('rate limiter is called with correct projectId and widgetUserId', async () => {
    const app = makeApp();
    await postAssign(app);
    expect(widgetRateLimiter.check).toHaveBeenCalledWith('proj-1', 'wu-123', 30);
  });

  it('getWidgetProjectRateLimit is called with projectId', async () => {
    const app = makeApp();
    await postAssign(app);
    expect(WidgetService.getWidgetProjectRateLimit).toHaveBeenCalledWith('proj-1');
  });
});
