import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
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
  class WidgetSettingsValidationError extends Error {}
  return {
    getWidgetIntegration: vi.fn(),
    enableWidget: vi.fn(),
    disableWidget: vi.fn(),
    getWidgetSettings: vi.fn(),
    updateWidgetSettings: vi.fn(),
    regenerateSecret: vi.fn(),
    WidgetSettingsValidationError,
  };
});
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import { extractUserIdFromToken } from './auth/jwt';
import * as ServerService from './services/ServerService';
import * as WidgetService from './services/WidgetService';

const SERVER = 'srv_1';
const PROJ_A = 'proj_test_a';
const PROJ_B = 'proj_test_b';

beforeEach(() => {
  vi.clearAllMocks();
  (extractUserIdFromToken as any).mockResolvedValue('user_1');
  (ServerService.checkCloudOpPermission as any).mockResolvedValue(true);
  (ServerService.getServer as any).mockResolvedValue({ id: SERVER, serverUrl: 'https://example' });
});

describe('Widget routes — per-project scoping', () => {
  it('GET /api/widget/integration forwards projectId from query', async () => {
    (WidgetService.getWidgetIntegration as any).mockImplementation(
      async (sid: string, pid: string) => ({ id: 'wp', name: pid === PROJ_A ? 'Moddio' : 'Snek' }),
    );
    const app = createHttpApp();
    const resA = await app.request(
      `http://localhost/api/widget/integration?serverId=${SERVER}&projectId=${PROJ_A}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    expect(resA.status).toBe(200);
    expect((await resA.json()).data.name).toBe('Moddio');
    expect(WidgetService.getWidgetIntegration).toHaveBeenCalledWith(SERVER, PROJ_A);

    const resB = await app.request(
      `http://localhost/api/widget/integration?serverId=${SERVER}&projectId=${PROJ_B}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    expect((await resB.json()).data.name).toBe('Snek');
    expect(WidgetService.getWidgetIntegration).toHaveBeenLastCalledWith(SERVER, PROJ_B);
  });

  it('GET /api/widget/integration without projectId returns 400', async () => {
    const app = createHttpApp();
    const res = await app.request(
      `http://localhost/api/widget/integration?serverId=${SERVER}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    expect(res.status).toBe(400);
    expect(WidgetService.getWidgetIntegration).not.toHaveBeenCalled();
  });

  it('POST /api/widget/enable without projectId returns 400 and does not call enableWidget', async () => {
    const app = createHttpApp();
    const res = await app.request('http://localhost/api/widget/enable', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, name: 'X', channelId: 'c' }),
    });
    expect(res.status).toBe(400);
    expect(WidgetService.enableWidget).not.toHaveBeenCalled();
  });

  it('POST /api/widget/enable with projectId forwards as workspaceProjectId', async () => {
    (WidgetService.enableWidget as any).mockResolvedValue({ id: 'wp_new', apiKey: 'k', apiSecretHash: 's' });
    const app = createHttpApp();
    const res = await app.request('http://localhost/api/widget/enable', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A, name: 'Snek', channelId: 'c1' }),
    });
    expect(res.status).toBe(200);
    expect(WidgetService.enableWidget).toHaveBeenCalledWith(
      SERVER,
      expect.objectContaining({ name: 'Snek', channelId: 'c1', workspaceProjectId: PROJ_A }),
    );
  });
});
