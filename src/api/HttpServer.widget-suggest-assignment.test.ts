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
  suggestAssignment: vi.fn(),
  listPublicProjects: vi.fn(),
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';

const makeApp = () => createHttpApp();

const AUTHED_WITH_ASSIGN = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  authenticated: true,
  permissions: new Set<string>(['assign_agent']),
  matchedRoles: ['triager'],
};

const postSuggest = (app: ReturnType<typeof makeApp>, ticketId = 'ticket-123') =>
  app.request(`/api/widget/tickets/${ticketId}/suggest-assignment`, { method: 'POST' });

describe('POST /api/widget/tickets/:id/suggest-assignment', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when authenticateWidget returns null', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await postSuggest(app);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('403 when permissions set is empty', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      projectId: 'proj-1',
      projectSlug: 'proj-1-slug',
      authenticated: true,
      permissions: new Set<string>(),
      matchedRoles: [],
    });
    const app = makeApp();
    const res = await postSuggest(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('403 when permissions does not include assign_agent', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      projectId: 'proj-1',
      projectSlug: 'proj-1-slug',
      authenticated: true,
      permissions: new Set<string>(['some_other']),
      matchedRoles: ['some_role'],
    });
    const app = makeApp();
    const res = await postSuggest(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('200 with agentId and command from suggestAssignment', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.suggestAssignment as any).mockResolvedValue({
      agentId: 'agent-99',
      command: 'Handle this ticket',
    });
    const app = makeApp();
    const res = await postSuggest(app, 'ticket-abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agentId: 'agent-99', command: 'Handle this ticket' });
    expect(WidgetService.suggestAssignment).toHaveBeenCalledWith('proj-1', 'ticket-abc');
  });

  it('200 with null agentId when no match found', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.suggestAssignment as any).mockResolvedValue({
      agentId: null,
      command: '',
    });
    const app = makeApp();
    const res = await postSuggest(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agentId: null, command: '' });
  });
});
