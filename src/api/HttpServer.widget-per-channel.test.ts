/**
 * Widget routes — per-channel scoping (Phase 5: channel-only).
 *
 * Phase 5 of the widget-per-channel migration: widget admin routes require
 * `?channelId=` (or its body equivalent) — the legacy `?projectId=` query
 * fallback was removed. Routes still read `projectId` from POST/PUT bodies
 * and DELETE query for the cache-invalidation payload, but never as a
 * lookup fallback.
 *
 * These tests mock WidgetService so we assert the HTTP route correctly
 * forwards the lookup shape to the service layer, not the DB-level behavior.
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

    it('without channelId returns 400', async () => {
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

    it('without channelId returns 400', async () => {
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

    it('without channelId returns 400', async () => {
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
    it('forwards channelId and the optional workspaceProjectId in the opts payload', async () => {
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

    it('forwards channelId without workspaceProjectId when projectId is omitted', async () => {
      (WidgetService.enableWidget as any).mockResolvedValue({ id: 'wp_new', apiKey: 'k', apiSecretHash: 's' });
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, channelId: CHAN_A, name: 'Snek' }),
      });
      expect(res.status).toBe(200);
      expect(WidgetService.enableWidget).toHaveBeenCalledTimes(1);
      const callArg = (WidgetService.enableWidget as any).mock.calls[0][1];
      expect(callArg).toMatchObject({ name: 'Snek', channelId: CHAN_A });
      expect(callArg).not.toHaveProperty('workspaceProjectId');
    });

    it('without channelId returns 400 and does not call enableWidget', async () => {
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A, name: 'Snek' }),
      });
      expect(res.status).toBe(400);
      expect(WidgetService.enableWidget).not.toHaveBeenCalled();
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

    it('without channelId returns 400', async () => {
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

    it('without channelId returns 400', async () => {
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

  // Phase 5: routes 400 when channelId is missing, even if projectId is
  // present in the query/body. The "channelId required" guard is exercised
  // per-route above; this group covers the only place projectId is still
  // honored — as a *non-lookup* passthrough into cache-invalidation —
  // which is verified in HttpServer.widget-cache-invalidate.test.ts.
  describe('Phase 5: ?projectId= alone is rejected', () => {
    it('GET /api/widget/integration 400s when only projectId is supplied', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/integration?serverId=${SERVER}&projectId=${PROJ_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.getWidgetIntegration).not.toHaveBeenCalled();
    });

    it('GET /api/widget/settings 400s when only projectId is supplied', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/settings?serverId=${SERVER}&projectId=${PROJ_A}`,
        { headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.getWidgetSettings).not.toHaveBeenCalled();
    });

    it('DELETE /api/widget/disable 400s when only projectId is supplied', async () => {
      const app = createHttpApp();
      const res = await app.request(
        `http://localhost/api/widget/disable?serverId=${SERVER}&projectId=${PROJ_A}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      );
      expect(res.status).toBe(400);
      expect(WidgetService.disableWidget).not.toHaveBeenCalled();
    });

    it('POST /api/widget/secret/regenerate 400s when only projectId is supplied', async () => {
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/secret/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A }),
      });
      expect(res.status).toBe(400);
      expect(WidgetService.regenerateSecret).not.toHaveBeenCalled();
    });

    it('PUT /api/widget/settings 400s when only projectId is supplied', async () => {
      const app = createHttpApp();
      const res = await app.request('http://localhost/api/widget/settings', {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: SERVER, projectId: PROJ_A, is_public: false }),
      });
      expect(res.status).toBe(400);
      expect(WidgetService.updateWidgetSettings).not.toHaveBeenCalled();
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
