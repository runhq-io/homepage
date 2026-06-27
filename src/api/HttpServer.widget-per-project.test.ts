/**
 * Widget admin routes — per-project scoping.
 *
 * The widget is one-per-project: admin routes resolve the row by `?projectId=`
 * (the workspaceProjectId). `channelId` is the target todo channel, carried in
 * enable/settings request bodies and forwarded as a settable field.
 *
 * These tests mock WidgetService and assert the HTTP route forwards the lookup
 * shape `{ workspaceProjectId }` and the target channelId to the service.
 */
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
    reconcileWidgetBindings: vi.fn(),
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
const PROJ = 'proj_test_a';
const CHAN = 'chan_todo_a';

beforeEach(() => {
  vi.clearAllMocks();
  (extractUserIdFromToken as any).mockResolvedValue('user_1');
  (ServerService.checkCloudOpPermission as any).mockResolvedValue(true);
  (ServerService.getServer as any).mockResolvedValue({ id: SERVER, serverUrl: 'https://example' });
});

describe('Widget admin routes — per-project scoping', () => {
  it('GET /integration forwards { workspaceProjectId } and 400s without projectId', async () => {
    (WidgetService.getWidgetIntegration as any).mockResolvedValue({ id: 'wp', channelId: CHAN });
    const app = createHttpApp();

    const ok = await app.request(
      `http://localhost/api/widget/integration?serverId=${SERVER}&projectId=${PROJ}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    expect(ok.status).toBe(200);
    expect(WidgetService.getWidgetIntegration).toHaveBeenCalledWith(SERVER, { workspaceProjectId: PROJ });

    const bad = await app.request(
      `http://localhost/api/widget/integration?serverId=${SERVER}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    expect(bad.status).toBe(400);
  });

  it('POST /enable requires projectId + channelId and forwards both', async () => {
    (WidgetService.enableWidget as any).mockResolvedValue({ id: 'wp', apiSecret: 's' });
    const app = createHttpApp();

    const res = await app.request('http://localhost/api/widget/enable', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, projectId: PROJ, name: 'My Project', channelId: CHAN }),
    });
    expect(res.status).toBe(200);
    expect(WidgetService.enableWidget).toHaveBeenCalledWith(SERVER, {
      name: 'My Project',
      channelId: CHAN,
      workspaceProjectId: PROJ,
    });

    const noProj = await app.request('http://localhost/api/widget/enable', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, name: 'My Project', channelId: CHAN }),
    });
    expect(noProj.status).toBe(400);
  });

  it('PUT /settings resolves by projectId and forwards channelId as the target', async () => {
    (WidgetService.updateWidgetSettings as any).mockResolvedValue({ autoInjectChanged: false });
    const app = createHttpApp();

    const res = await app.request('http://localhost/api/widget/settings', {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, projectId: PROJ, channelId: CHAN, widget_position: 'top-left' }),
    });
    expect(res.status).toBe(200);
    const [, settingsArg, lookupArg] = (WidgetService.updateWidgetSettings as any).mock.calls[0];
    expect(settingsArg.channelId).toBe(CHAN);
    expect(lookupArg).toEqual({ workspaceProjectId: PROJ });
  });

  it('DELETE /disable resolves by projectId', async () => {
    (WidgetService.disableWidget as any).mockResolvedValue(undefined);
    const app = createHttpApp();
    const res = await app.request(
      `http://localhost/api/widget/disable?serverId=${SERVER}&projectId=${PROJ}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
    );
    expect(res.status).toBe(200);
    expect(WidgetService.disableWidget).toHaveBeenCalledWith(SERVER, { workspaceProjectId: PROJ });
  });

  it('POST /secret/regenerate resolves by projectId', async () => {
    (WidgetService.regenerateSecret as any).mockResolvedValue({ apiSecret: 'new' });
    const app = createHttpApp();
    const res = await app.request('http://localhost/api/widget/secret/regenerate', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: SERVER, projectId: PROJ }),
    });
    expect(res.status).toBe(200);
    expect(WidgetService.regenerateSecret).toHaveBeenCalledWith(SERVER, { workspaceProjectId: PROJ });
  });
});
