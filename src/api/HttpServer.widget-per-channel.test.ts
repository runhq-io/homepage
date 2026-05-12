/**
 * Widget routes — per-channel scoping (additive, backward-compatible)
 *
 * Phase 1 of the widget-per-channel migration: widget admin routes accept a
 * new `?channelId=` query param (and the corresponding lookup object passed
 * into WidgetService). The legacy `?projectId=` form must continue to work
 * verbatim — see `HttpServer.widget-per-project.test.ts` for the backward-
 * compat tests.
 *
 * These tests use the same mock pattern as `widget-per-project.test.ts`:
 * the WidgetService is mocked so we assert the HTTP route correctly forwards
 * the lookup shape to the service layer, not the DB-level behavior.
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
    reconcileUnbackfilledWidgets: vi.fn(),
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
const CHAN_A = 'chan_todo_a';
const CHAN_B = 'chan_todo_b';

beforeEach(() => {
  vi.clearAllMocks();
  (extractUserIdFromToken as any).mockResolvedValue('user_1');
  (ServerService.checkCloudOpPermission as any).mockResolvedValue(true);
  (ServerService.getServer as any).mockResolvedValue({ id: SERVER, serverUrl: 'https://example' });
});

describe('Widget routes — per-channel scoping (additive)', () => {
  describe('GET /api/widget/integration', () => {
    it('forwards channelId as a WidgetLookup object to the service', async () => {
      (WidgetService.getWidgetIntegration as any).mockResolvedValue({ id: 'wp', channelId: CHAN_A });
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/integration?serverId=${SERVER}&channelId=${CHAN_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.channelId).toBe(CHAN_A);
      expect(WidgetService.getWidgetIntegration).toHaveBeenCalledWith(
        SERVER,
        { channelId: CHAN_A },
      );
    });

    it('prefers channelId over projectId when both are supplied', async () => {
      (WidgetService.getWidgetIntegration as any).mockResolvedValue({ id: 'wp', channelId: CHAN_A });
      const app = createHttpApp();
      await app.request(
        `http://localhost/api/widget/integration?serverId=${SERVER}&channelId=${CHAN_A}&projectId=${PROJ_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(WidgetService.getWidgetIntegration).toHaveBeenCalledWith(
        SERVER,
        { channelId: CHAN_A },
      );
    });

    it('without channelId or projectId returns 400', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/integration?serverId=${SERVER}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.getWidgetIntegration).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/widget/settings', () => {
    it('forwards channelId to the service', async () => {
      (WidgetService.getWidgetSettings as any).mockResolvedValue({ channel_id: CHAN_A });
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/settings?serverId=${SERVER}&channelId=${CHAN_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      expect(WidgetService.getWidgetSettings).toHaveBeenCalledWith(
        SERVER,
        { channelId: CHAN_A },
      );
    });

    it('without channelId or projectId returns 400', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/settings?serverId=${SERVER}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.getWidgetSettings).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/widget/settings', () => {
    it('forwards channelId as opts.lookup to updateWidgetSettings', async () => {
      (WidgetService.updateWidgetSettings as any).mockResolvedValue({ autoInjectChanged: false });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/settings', {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, channelId: CHAN_A, is_public: false }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.updateWidgetSettings).toHaveBeenCalledWith(
        SERVER,
        expect.objectContaining({ is_public: false }),
        { channelId: CHAN_A },
      );
    });

    it('without channelId or projectId returns 400', async () => {
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/settings', {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, is_public: false }),
      });
      expect(res.status).toBe(400);
      expect(WidgetService.updateWidgetSettings).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/widget/enable', () => {
    it('forwards channelId in the opts payload (workspaceProjectId still required)', async () => {
      (WidgetService.enableWidget as any).mockResolvedValue({ id: 'wp_new', apiKey: 'k', apiSecretHash: 's' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A, channelId: CHAN_A, name: 'Snek' }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.enableWidget).toHaveBeenCalledWith(
        SERVER,
        expect.objectContaining({ name: 'Snek', channelId: CHAN_A, workspaceProjectId: PROJ_A }),
      );
    });
  });

  describe('DELETE /api/widget/disable', () => {
    it('forwards channelId to disableWidget', async () => {
      (WidgetService.disableWidget as any).mockResolvedValue(undefined);
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/disable?serverId=${SERVER}&channelId=${CHAN_A}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      expect(WidgetService.disableWidget).toHaveBeenCalledWith(
        SERVER,
        { channelId: CHAN_A },
      );
    });

    it('without channelId or projectId returns 400', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/disable?serverId=${SERVER}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.disableWidget).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/widget/secret/regenerate', () => {
    it('forwards channelId to regenerateSecret', async () => {
      (WidgetService.regenerateSecret as any).mockResolvedValue({ apiSecret: 'new' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/secret/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, channelId: CHAN_B }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.regenerateSecret).toHaveBeenCalledWith(
        SERVER,
        { channelId: CHAN_B },
      );
    });

    it('without channelId or projectId returns 400', async () => {
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/secret/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER }),
      });
      expect(res.status).toBe(400);
      expect(WidgetService.regenerateSecret).not.toHaveBeenCalled();
    });
  });

  // Backward-compat: every route still accepts ?projectId= and forwards it
  // as a workspaceProjectId-keyed lookup. The legacy positional-string form
  // is also acceptable; the route uses the object form when constructing the
  // lookup so the service-layer signature is consistent across both query
  // shapes.
  describe('Backward-compat: ?projectId= still routes through', () => {
    it('GET /api/widget/integration forwards projectId as workspaceProjectId lookup', async () => {
      (WidgetService.getWidgetIntegration as any).mockResolvedValue({ id: 'wp', name: 'X' });
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/integration?serverId=${SERVER}&projectId=${PROJ_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      expect(WidgetService.getWidgetIntegration).toHaveBeenCalledWith(
        SERVER,
        { workspaceProjectId: PROJ_A },
      );
    });

    it('GET /api/widget/settings forwards projectId as workspaceProjectId lookup', async () => {
      (WidgetService.getWidgetSettings as any).mockResolvedValue({});
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/settings?serverId=${SERVER}&projectId=${PROJ_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      expect(WidgetService.getWidgetSettings).toHaveBeenCalledWith(
        SERVER,
        { workspaceProjectId: PROJ_A },
      );
    });

    it('DELETE /api/widget/disable forwards projectId as workspaceProjectId lookup', async () => {
      (WidgetService.disableWidget as any).mockResolvedValue(undefined);
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/disable?serverId=${SERVER}&projectId=${PROJ_A}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(200);
      expect(WidgetService.disableWidget).toHaveBeenCalledWith(
        SERVER,
        { workspaceProjectId: PROJ_A },
      );
    });

    it('POST /api/widget/secret/regenerate forwards projectId as workspaceProjectId lookup', async () => {
      (WidgetService.regenerateSecret as any).mockResolvedValue({ apiSecret: 'new' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/secret/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.regenerateSecret).toHaveBeenCalledWith(
        SERVER,
        { workspaceProjectId: PROJ_A },
      );
    });

    it('PUT /api/widget/settings forwards projectId as workspaceProjectId lookup', async () => {
      (WidgetService.updateWidgetSettings as any).mockResolvedValue({ autoInjectChanged: false });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/settings', {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A, is_public: false }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.updateWidgetSettings).toHaveBeenCalledWith(
        SERVER,
        expect.objectContaining({ is_public: false }),
        { workspaceProjectId: PROJ_A },
      );
    });
  });

  describe('POST /api/widget/reconcile', () => {
    it('backfills channel_id from projectToPrimaryTodoChannel', async () => {
      // Mock-based test following the file's existing convention.
      // Mock WidgetService.reconcileWidgetBindings.
      (WidgetService.reconcileWidgetBindings as any).mockResolvedValue({ updated: 1 });
      (ServerService.getServerByToken as any).mockResolvedValue({ id: 'srv-1' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/reconcile', {
        method: 'POST',
        headers: { 'X-Server-Token': 'srv-tok-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelToProject: { 'chan-1': 'proj-1' },
          projectToPrimaryTodoChannel: { 'proj-1': 'chan-1' },
        }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.reconcileWidgetBindings).toHaveBeenCalledWith(
        'srv-1',
        {
          channelToProject: { 'chan-1': 'proj-1' },
          projectToPrimaryTodoChannel: { 'proj-1': 'chan-1' },
        },
      );
    });

    it('accepts payload missing projectToPrimaryTodoChannel (backward compat)', async () => {
      (WidgetService.reconcileWidgetBindings as any).mockResolvedValue({ updated: 0 });
      (ServerService.getServerByToken as any).mockResolvedValue({ id: 'srv-1' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/reconcile', {
        method: 'POST',
        headers: { 'X-Server-Token': 'srv-tok-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelToProject: { c: 'p' } }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.reconcileWidgetBindings).toHaveBeenLastCalledWith(
        'srv-1',
        { channelToProject: { c: 'p' }, projectToPrimaryTodoChannel: {} },
      );
    });
  });
});
