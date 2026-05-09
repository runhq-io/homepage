import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({ checkCloudOpPermission: vi.fn(), getServer: vi.fn(), fetchFromServer: vi.fn() }));

vi.mock('./services/WidgetService', () => ({
  authenticateWidget: vi.fn(),
  listExposedAgents: vi.fn(),
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

describe('GET /api/widget/agents', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when authenticateWidget returns null', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/api/widget/agents');
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
    const res = await app.request('/api/widget/agents');
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
    const res = await app.request('/api/widget/agents');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('200 with empty agents array', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.listExposedAgents as any).mockResolvedValue([]);
    const app = makeApp();
    const res = await app.request('/api/widget/agents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agents: [] });
  });

  it('200 with two agents in response', async () => {
    const agents = [
      { id: 'agent-1', name: 'Alpha Agent', description: 'Handles alpha tasks' },
      { id: 'agent-2', name: 'Beta Agent', description: null },
    ];
    (WidgetService.authenticateWidget as any).mockResolvedValue(AUTHED_WITH_ASSIGN);
    (WidgetService.listExposedAgents as any).mockResolvedValue(agents);
    const app = makeApp();
    const res = await app.request('/api/widget/agents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toEqual({ id: 'agent-1', name: 'Alpha Agent', description: 'Handles alpha tasks' });
    expect(body.agents[1]).toEqual({ id: 'agent-2', name: 'Beta Agent', description: null });
  });
});

describe('GET /api/widget/me', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when authenticateWidget returns null', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request('/api/widget/me');
    expect(res.status).toBe(401);
  });

  it('200 with isTriager=true when permissions include assign_agent', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      projectId: 'p1',
      projectSlug: 's1',
      widgetUserId: 'u1',
      authenticated: true,
      permissions: new Set(['assign_agent']),
      matchedRoles: ['triager'],
    });
    const app = makeApp();
    const res = await app.request('/api/widget/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      widgetUserId: 'u1',
      permissions: ['assign_agent'],
      matchedRoles: ['triager'],
      isTriager: true,
    });
  });

  it('200 with isTriager=false otherwise', async () => {
    (WidgetService.authenticateWidget as any).mockResolvedValue({
      projectId: 'p1',
      projectSlug: 's1',
      widgetUserId: undefined,
      authenticated: false,
      permissions: new Set(),
      matchedRoles: [],
    });
    const app = makeApp();
    const res = await app.request('/api/widget/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      widgetUserId: null,
      permissions: [],
      matchedRoles: [],
      isTriager: false,
    });
  });
});
