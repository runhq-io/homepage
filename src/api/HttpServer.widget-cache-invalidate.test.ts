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
}));

vi.mock('./services/WidgetService', () => {
  class WidgetSettingsValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WidgetSettingsValidationError';
    }
  }

  return {
    enableWidget: vi.fn(),
    disableWidget: vi.fn(),
    updateWidgetSettings: vi.fn(),
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
import { extractUserIdFromToken } from './auth/jwt';
import * as ServerService from './services/ServerService';
import * as WidgetService from './services/WidgetService';

const mockServer = { id: 'srv_1', serverUrl: 'https://server.example.com' } as any;

async function sendJson(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  const app = createHttpApp();
  return app.request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: 'Bearer web-token',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('widget cache invalidation route wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (extractUserIdFromToken as any).mockResolvedValue('user_1');
    (ServerService.checkCloudOpPermission as any).mockResolvedValue(true);
    (ServerService.getServer as any).mockResolvedValue(mockServer);
    (ServerService.fetchFromServer as any).mockResolvedValue({ success: true });
  });

  it('POST /api/widget/enable push-invalidates preview widget cache', async () => {
    (WidgetService.enableWidget as any).mockResolvedValue({ id: 'wp_1' });

    const res = await sendJson('POST', '/api/widget/enable', {
      serverId: 'srv_1',
      name: 'Widget Project',
      channelId: 'ch_1',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    await flushMicrotasks();

    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(
      mockServer,
      'user_1',
      '/__preview/config-invalidate',
      { method: 'POST', body: { kind: 'widget' } },
    );
  });

  it('DELETE /api/widget/disable push-invalidates preview widget cache', async () => {
    (WidgetService.disableWidget as any).mockResolvedValue(undefined);

    const res = await sendJson('DELETE', '/api/widget/disable?serverId=srv_1');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    await flushMicrotasks();

    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(
      mockServer,
      'user_1',
      '/__preview/config-invalidate',
      { method: 'POST', body: { kind: 'widget' } },
    );
  });

  it('PUT /api/widget/settings push-invalidates even when autoInjectChanged is false', async () => {
    (WidgetService.updateWidgetSettings as any).mockResolvedValue({ autoInjectChanged: false });

    const res = await sendJson('PUT', '/api/widget/settings', {
      serverId: 'srv_1',
      auto_approve: true,
      widget_position: 'bottom-right',
      is_public: true,
      auto_inject_in_preview: true,
      slug: 'widget-project',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    await flushMicrotasks();

    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(
      mockServer,
      'user_1',
      '/__preview/config-invalidate',
      { method: 'POST', body: { kind: 'widget' } },
    );
  });

  it('does not push-invalidate when widget settings validation fails', async () => {
    (WidgetService.updateWidgetSettings as any).mockRejectedValue(
      new WidgetService.WidgetSettingsValidationError('channel required'),
    );

    const res = await sendJson('PUT', '/api/widget/settings', {
      serverId: 'srv_1',
      auto_inject_in_preview: true,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'channel required' });

    await flushMicrotasks();

    expect(ServerService.fetchFromServer).not.toHaveBeenCalled();
  });
});
