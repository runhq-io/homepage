/**
 * Route-level wiring tests for POST /api/widget/tickets/:id/clarify-proceed —
 * the duplicate override ("Not a duplicate — start anyway"). Auth gating,
 * body validation, ownership (404), state guard (409), and the assign tail
 * invoked with dedup skipped. Behavior is service-tested against the real DB
 * (ClarifierService.test.ts / WidgetAutoAssign.test.ts); here services are
 * mocked, mirroring HttpServer.widget-chat.test.ts.
 */
import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  getServerByToken: vi.fn(),
  serverTokenFetch: vi.fn(),
}));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));
vi.mock('./services/ClarifierService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/ClarifierService')>();
  return { ...actual, getOwnedClarification: vi.fn(), overrideDuplicate: vi.fn() };
});
vi.mock('./services/WidgetAutoAssign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/WidgetAutoAssign')>();
  return { ...actual, finalizeAutoAssignTicket: vi.fn() };
});
vi.mock('./services/WidgetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/WidgetService')>();
  return { ...actual, authenticateWidget: vi.fn() };
});

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as ClarifierService from './services/ClarifierService';
import * as WidgetAutoAssign from './services/WidgetAutoAssign';

const makeApp = () => createHttpApp();

const IDENTIFIED = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  widgetUserId: 'wu-1',
  authenticated: true,
  permissions: new Set<string>(),
  matchedRoles: [],
  authSource: 'app' as const,
};

const TICKET_ID = 'task-1';
const CLAR_ID = '33333333-3333-4333-a333-333333333333';
const DUP_CLAR = {
  id: CLAR_ID,
  taskId: TICKET_ID,
  serverId: 'ws-1',
  widgetUserId: 'wu-1',
  agentId: '__auto__',
  command: '',
  status: 'duplicate' as const,
  duplicateOfTaskId: 'task-original',
  round: 0,
  createdAt: new Date('2026-06-12T00:00:00Z'),
  updatedAt: new Date('2026-06-12T00:00:00Z'),
};

const URL = `/api/widget/tickets/${TICKET_ID}/clarify-proceed`;
const post = (body?: unknown) =>
  makeApp().request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('POST /api/widget/tickets/:id/clarify-proceed', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when authenticateWidget returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null as any);
    expect((await post({ clarificationId: CLAR_ID })).status).toBe(401);
  });

  it('401 for anonymous viewers (no widgetUserId)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue({ ...IDENTIFIED, widgetUserId: undefined } as any);
    expect((await post({ clarificationId: CLAR_ID })).status).toBe(401);
  });

  it('400 when clarificationId is missing or not a string', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    expect((await post({})).status).toBe(400);
    expect((await post({ clarificationId: 42 })).status).toBe(400);
    expect((await post()).status).toBe(400);
  });

  it('404 when the clarification is not owned by this ticket + reporter', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(ClarifierService.getOwnedClarification).mockResolvedValue(null);
    const res = await post({ clarificationId: CLAR_ID });
    expect(res.status).toBe(404);
    expect(ClarifierService.getOwnedClarification).toHaveBeenCalledWith(CLAR_ID, {
      taskId: TICKET_ID,
      widgetUserId: 'wu-1',
    });
  });

  it('409 when the clarification is not flagged duplicate (already processed)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(ClarifierService.getOwnedClarification).mockResolvedValue({ ...DUP_CLAR, status: 'ready' } as any);
    const res = await post({ clarificationId: CLAR_ID });
    expect(res.status).toBe(409);
    expect(ClarifierService.overrideDuplicate).not.toHaveBeenCalled();
    expect(WidgetAutoAssign.finalizeAutoAssignTicket).not.toHaveBeenCalled();
  });

  it('clears the flag and runs the assign tail with dedup skipped', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(ClarifierService.getOwnedClarification).mockResolvedValue(DUP_CLAR as any);
    vi.mocked(WidgetAutoAssign.finalizeAutoAssignTicket).mockResolvedValue({
      status: 'assigned', agentId: 'agent_a', jobId: 'job_9',
    } as any);

    const res = await post({ clarificationId: CLAR_ID });
    expect(res.status).toBe(200);
    expect(ClarifierService.overrideDuplicate).toHaveBeenCalledWith(CLAR_ID);
    expect(WidgetAutoAssign.finalizeAutoAssignTicket).toHaveBeenCalledWith(
      'proj-1', TICKET_ID, 'wu-1', { skipDedup: true },
    );
    expect(await res.json()).toEqual({
      clarification: { status: 'started' },
      outcome: { status: 'assigned', agentId: 'agent_a', jobId: 'job_9' },
    });
  });

  it('returns started + failed outcome when the assign tail throws (override stays recorded)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(ClarifierService.getOwnedClarification).mockResolvedValue(DUP_CLAR as any);
    vi.mocked(WidgetAutoAssign.finalizeAutoAssignTicket).mockRejectedValue(new Error('workspace down'));

    const res = await post({ clarificationId: CLAR_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clarification: { status: 'started' },
      outcome: { status: 'failed' },
    });
  });
});
