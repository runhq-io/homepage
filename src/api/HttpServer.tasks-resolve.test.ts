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
  getUserServers: vi.fn(),
}));

vi.mock('./services/WorkspaceTaskService', async () => {
  // Keep the real pure helpers (parse/select); only stub the DB query.
  const actual = await vi.importActual<typeof import('./services/WorkspaceTaskService')>(
    './services/WorkspaceTaskService',
  );
  return {
    ...actual,
    resolveTaskCandidates: vi.fn(),
  };
});

vi.mock('./services/WidgetService', () => ({
  syncProjectMetadata: vi.fn(),
  WidgetSettingsValidationError: class extends Error {},
}));

vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class {
    isConfigured() {
      return false;
    }
  },
}));

import { createHttpApp } from './HttpServer';
import * as ServerService from './services/ServerService';
import * as WorkspaceTaskService from './services/WorkspaceTaskService';
import { extractUserIdFromToken } from './auth/jwt';

const USER_ID = 'user_1';
const SERVER_ID = 'ws_mm4m8jhy_8fywlw';
const FULL = '05806cc6-e75f-40a6-a3e2-baf0dbac2fb9';
const SHORT = '05806cc6';

function row(over: Partial<any> = {}) {
  return {
    serverId: SERVER_ID,
    channelId: 'chan_todo',
    taskId: FULL,
    title: 'Fix the thing',
    legacyWorkspaceTodoId: null,
    createdAt: 1000,
    ...over,
  };
}

async function resolve(shortId: string, opts?: { token?: string | null }): Promise<Response> {
  const app = createHttpApp();
  const headers: Record<string, string> = {};
  if (opts?.token !== null) headers['Authorization'] = `Bearer ${opts?.token ?? 'jwt_token'}`;
  return app.request(`http://localhost/api/tasks/${encodeURIComponent(shortId)}/resolve`, { headers });
}

describe('GET /api/tasks/:shortId/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (extractUserIdFromToken as any).mockResolvedValue(USER_ID);
    (WorkspaceTaskService.resolveTaskCandidates as any).mockResolvedValue([row()]);
    (ServerService.getUserServers as any).mockResolvedValue([{ id: SERVER_ID }]);
  });

  it('resolves a full UUID to its server + channel + task routing tuple', async () => {
    const res = await resolve(FULL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { serverId: SERVER_ID, channelId: 'chan_todo', taskId: FULL, title: 'Fix the thing' },
    });
    expect(WorkspaceTaskService.resolveTaskCandidates).toHaveBeenCalledWith({ kind: 'exact', value: FULL });
  });

  it('resolves an 8-char short id (prefix query)', async () => {
    const res = await resolve(SHORT);
    expect(res.status).toBe(200);
    expect((await res.json()).data.taskId).toBe(FULL);
    expect(WorkspaceTaskService.resolveTaskCandidates).toHaveBeenCalledWith({ kind: 'prefix', value: SHORT });
  });

  it('returns 400 for a malformed id without touching the DB', async () => {
    const res = await resolve('not-an-id');
    expect(res.status).toBe(400);
    expect(WorkspaceTaskService.resolveTaskCandidates).not.toHaveBeenCalled();
  });

  it('returns 401 when no auth token is present (in production)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      (extractUserIdFromToken as any).mockResolvedValue(null);
      const res = await resolve(FULL, { token: null });
      expect(res.status).toBe(401);
      expect(WorkspaceTaskService.resolveTaskCandidates).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns 404 when no task matches the id', async () => {
    (WorkspaceTaskService.resolveTaskCandidates as any).mockResolvedValue([]);
    const res = await resolve(FULL);
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when the user cannot reach the owning server', async () => {
    (ServerService.getUserServers as any).mockResolvedValue([{ id: 'some_other_server' }]);
    const res = await resolve(FULL);
    expect(res.status).toBe(404);
  });
});
