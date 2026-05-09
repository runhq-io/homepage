import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({
  default: new Hono(),
}));

vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));

vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  getServerByToken: vi.fn(),
}));

vi.mock('./services/WidgetService', () => {
  class WidgetSettingsValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WidgetSettingsValidationError';
    }
  }

  return {
    syncWidgetExposedAgents: vi.fn(),
    WidgetSettingsValidationError,
  };
});

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class {
    isConfigured() {
      return false;
    }
  },
}));

import { createHttpApp } from './HttpServer';
import * as ServerService from './services/ServerService';
import * as WidgetService from './services/WidgetService';

const SERVER_ID = 'srv_sync_test_1';
const TOKEN = 'wst_sync_token';

async function postSync(
  body: unknown,
  opts?: { token?: string | null; serverId?: string },
): Promise<Response> {
  const app = createHttpApp();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token !== null) headers['X-Server-Token'] = opts?.token ?? TOKEN;
  return app.request(
    `http://localhost/api/internal/servers/${opts?.serverId ?? SERVER_ID}/widget-agents/sync`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe('POST /api/internal/servers/:serverId/widget-agents/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ServerService.getServerByToken as any).mockResolvedValue({ id: SERVER_ID });
    (WidgetService.syncWidgetExposedAgents as any).mockResolvedValue({ upserted: 0, removed: 0 });
  });

  it('returns 401 when X-Server-Token header is missing', async () => {
    const res = await postSync({ projects: [] }, { token: null });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/X-Server-Token/);
    expect(WidgetService.syncWidgetExposedAgents).not.toHaveBeenCalled();
  });

  it('returns 401 when token resolves to a different server than the URL', async () => {
    (ServerService.getServerByToken as any).mockResolvedValue({ id: 'srv_other' });
    const res = await postSync({
      projects: [{ workspaceProjectId: 'proj1', agents: [] }],
    });
    expect(res.status).toBe(401);
    expect(WidgetService.syncWidgetExposedAgents).not.toHaveBeenCalled();
  });

  it('returns 400 when body has no projects array', async () => {
    expect((await postSync({})).status).toBe(400);
    expect((await postSync({ projects: 'nope' })).status).toBe(400);
    expect((await postSync(null)).status).toBe(400);
    expect(WidgetService.syncWidgetExposedAgents).not.toHaveBeenCalled();
  });

  it('returns 400 when an agent entry is missing required fields', async () => {
    // missing id
    expect(
      (await postSync({
        projects: [{ workspaceProjectId: 'p1', agents: [{ name: 'Agent' }] }],
      })).status,
    ).toBe(400);
    // missing name
    expect(
      (await postSync({
        projects: [{ workspaceProjectId: 'p1', agents: [{ id: 'a1' }] }],
      })).status,
    ).toBe(400);
    // id not string
    expect(
      (await postSync({
        projects: [{ workspaceProjectId: 'p1', agents: [{ id: 42, name: 'Agent' }] }],
      })).status,
    ).toBe(400);
    // missing workspaceProjectId
    expect(
      (await postSync({
        projects: [{ agents: [{ id: 'a1', name: 'Agent' }] }],
      })).status,
    ).toBe(400);
    expect(WidgetService.syncWidgetExposedAgents).not.toHaveBeenCalled();
  });

  it('returns 200 with { ok: true, upserted, removed } and calls service with correct args', async () => {
    (WidgetService.syncWidgetExposedAgents as any).mockResolvedValue({ upserted: 3, removed: 1 });

    const projects = [
      {
        workspaceProjectId: 'proj_alpha',
        agents: [
          { id: 'agent-1', name: 'Alpha', description: 'Handles alpha' },
          { id: 'agent-2', name: 'Beta', description: null },
        ],
      },
      {
        workspaceProjectId: 'proj_bravo',
        agents: [],
      },
    ];

    const res = await postSync({ projects });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, upserted: 3, removed: 1 });
    expect(WidgetService.syncWidgetExposedAgents).toHaveBeenCalledOnce();
    expect(WidgetService.syncWidgetExposedAgents).toHaveBeenCalledWith(SERVER_ID, projects);
  });

  it('returns 200 with agents where description is undefined (omitted)', async () => {
    (WidgetService.syncWidgetExposedAgents as any).mockResolvedValue({ upserted: 1, removed: 0 });

    const res = await postSync({
      projects: [
        {
          workspaceProjectId: 'proj_x',
          agents: [{ id: 'agent-x', name: 'X Agent' }], // description omitted (undefined)
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(WidgetService.syncWidgetExposedAgents).toHaveBeenCalledOnce();
  });

  it('returns 500 when syncWidgetExposedAgents throws', async () => {
    (WidgetService.syncWidgetExposedAgents as any).mockRejectedValue(new Error('db down'));
    const res = await postSync({
      projects: [{ workspaceProjectId: 'p1', agents: [{ id: 'a1', name: 'A' }] }],
    });
    expect(res.status).toBe(500);
  });
});
