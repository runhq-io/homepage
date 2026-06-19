/**
 * Route-level wiring tests for POST /api/widget/tickets/:id/preview.
 *
 * Covers:
 *   • 401 when authenticateWidget returns null
 *   • 403 when the authenticated user lacks live_coder permission
 *   • { ok:false, reason:'no_preview' } when the ticket has no linked branch
 *   • { ok:false, reason:'unavailable' } when no workspace server is found
 *   • { ok:true, url, status } when the workspace returns a ready/starting preview
 *   • { ok:true, status:'preparing' } (no url) when the workspace is still booting
 *   • { ok:false, reason } relay when the workspace replies ok:false
 *
 * Services are mocked; DB and workspace network are never hit.
 */
import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

// Mock ServerService — we only need getServer and serverTokenFetch here.
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  checkServerPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  getServerByToken: vi.fn(),
  serverTokenFetch: vi.fn(),
}));

// Mock WidgetService — spread actual so WidgetError et al. stay real;
// override authenticateWidget, getTicketPreviewBranch, and getProjectServer.
vi.mock('./services/WidgetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/WidgetService')>();
  return {
    ...actual,
    authenticateWidget: vi.fn(),
    getTicketPreviewBranch: vi.fn(),
    getProjectServer: vi.fn(),
  };
});

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as ServerService from './services/ServerService';

const makeApp = () => createHttpApp();

const TICKET_ID = 'tkt-preview-00001';
const BRANCH = 'feat/preview-branch';
const SERVER = { id: 'srv-preview-1', serverUrl: 'http://ws.local', tokenHash: 'h' };

/** Auth result with live_coder permission. */
const LIVE_CODER_AUTH = {
  projectId: 'proj-preview',
  projectSlug: 'proj-preview-slug',
  widgetUserId: 'wu-staff-1',
  authenticated: true,
  permissions: new Set(['live_coder']),
  matchedRoles: ['live_coder'],
  authSource: 'app' as const,
};

/** Auth result without live_coder permission. */
const VIEWER_AUTH = {
  ...LIVE_CODER_AUTH,
  permissions: new Set<string>(),
  matchedRoles: [],
};

const POST_PREVIEW = {
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
};

describe('POST /api/widget/tickets/:id/preview', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: server resolves fine via the WidgetService helper (mockable, no DB).
    vi.mocked(WidgetService.getProjectServer).mockResolvedValue(SERVER as any);
  });

  it('401 when authenticateWidget returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null as any);
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Unauthorized');
  });

  it('403 when authenticated user lacks live_coder permission', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(VIEWER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('{ ok:false, reason:"no_preview" } when the ticket has no linked branch', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(null);
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'no_preview' });
  });

  it('{ ok:false, reason:"unavailable" } when getProjectServer returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    vi.mocked(WidgetService.getProjectServer).mockResolvedValue(null as any);
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('ready: { ok:true, url, status } when workspace returns publicUrl + token', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({
      ok: true,
      publicUrl: 'https://3101-m.preview.x',
      token: 't',
      status: 'starting',
    });
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      url: 'https://3101-m.preview.x?__preview_token=t',
      status: 'starting',
    });
    expect(body.url).not.toContain('undefined');
  });

  it('preparing: { ok:true, status:"preparing" } with NO url when publicUrl is null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({
      ok: true,
      publicUrl: null,
      token: null,
      status: 'preparing',
    });
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('preparing');
    // MUST NOT include url — the widget uses absence of url to know to poll
    expect(body.url).toBeUndefined();
  });

  it('relays workspace ok:false with its reason', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({
      ok: false,
      reason: 'no_preview',
    });
    const res = await makeApp().request(
      `/api/widget/tickets/${TICKET_ID}/preview`,
      POST_PREVIEW,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'no_preview' });
  });

  it('forwards branch to workspace serverTokenFetch', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(LIVE_CODER_AUTH as any);
    vi.mocked(WidgetService.getTicketPreviewBranch).mockResolvedValue(BRANCH);
    vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({
      ok: true,
      publicUrl: 'https://3101-m.preview.x',
      token: 'tok',
      status: 'ready',
    });
    await makeApp().request(`/api/widget/tickets/${TICKET_ID}/preview`, POST_PREVIEW);
    expect(ServerService.serverTokenFetch).toHaveBeenCalledWith(
      SERVER,
      '/internal/preview/start',
      { branch: BRANCH },
    );
  });
});
