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
    syncProjectMetadata: vi.fn(),
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

const SERVER_ID = 'srv_test_1';
const TOKEN = 'wst_test_token';

async function postSync(
  body: unknown,
  opts?: { token?: string | null; serverId?: string },
): Promise<Response> {
  const app = createHttpApp();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token !== null) headers['X-Server-Token'] = opts?.token ?? TOKEN;
  return app.request(
    `http://localhost/api/internal/servers/${opts?.serverId ?? SERVER_ID}/projects/sync`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe('POST /api/internal/servers/:serverId/projects/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ServerService.getServerByToken as any).mockResolvedValue({ id: SERVER_ID });
    (WidgetService.syncProjectMetadata as any).mockResolvedValue({ updated: 1 });
  });

  it('returns 401 when X-Server-Token header is missing', async () => {
    const res = await postSync({ projects: [] }, { token: null });
    expect(res.status).toBe(401);
    expect(WidgetService.syncProjectMetadata).not.toHaveBeenCalled();
  });

  it('returns 401 when token resolves to a different server than the URL', async () => {
    (ServerService.getServerByToken as any).mockResolvedValue({ id: 'srv_other' });
    const res = await postSync({ projects: [{ id: 'p1', name: 'X' }] });
    expect(res.status).toBe(401);
    expect(WidgetService.syncProjectMetadata).not.toHaveBeenCalled();
  });

  it('returns 400 when body.projects is missing or not an array', async () => {
    expect((await postSync({})).status).toBe(400);
    expect((await postSync({ projects: 'nope' })).status).toBe(400);
  });

  it('returns 400 when an entry is missing id or name', async () => {
    expect((await postSync({ projects: [{ id: 'p1' }] })).status).toBe(400);
    expect((await postSync({ projects: [{ name: 'X' }] })).status).toBe(400);
    expect((await postSync({ projects: [{ id: 1, name: 'X' }] })).status).toBe(400);
  });

  it('forwards a valid payload to syncProjectMetadata and returns its result', async () => {
    (WidgetService.syncProjectMetadata as any).mockResolvedValue({ updated: 2 });
    const res = await postSync({
      projects: [
        { id: 'proj_a', name: '제주닷컴' },
        { id: 'proj_b', name: 'Other' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    expect(WidgetService.syncProjectMetadata).toHaveBeenCalledWith(
      SERVER_ID,
      [
        { id: 'proj_a', name: '제주닷컴' },
        { id: 'proj_b', name: 'Other' },
      ],
    );
  });

  it('returns 500 when syncProjectMetadata throws', async () => {
    (WidgetService.syncProjectMetadata as any).mockRejectedValue(new Error('db down'));
    const res = await postSync({ projects: [{ id: 'p1', name: 'X' }] });
    expect(res.status).toBe(500);
  });
});
