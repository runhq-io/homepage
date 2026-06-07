/**
 * Route-level wiring tests for the widget chat API: auth gating (401 anon
 * project / 403 unidentified user), WidgetError → HTTP mapping, body
 * validation, and the X-Server-Token guard on the internal events callback.
 * Behavior is service-tested against the real DB; here services are mocked.
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
vi.mock('./services/WidgetChatService', () => ({
  getOrCreateActiveConversation: vi.fn(),
  getActiveConversation: vi.fn(),
  getConversationOwned: vi.fn(),
  listMessages: vi.fn(),
  sendUserMessage: vi.fn(),
  forceProposal: vi.fn(),
  createTicketFromChat: vi.fn(),
  submitTicketFromConversation: vi.fn(),
  dismissProposal: vi.fn(),
  ingestTurnEvents: vi.fn(),
  subscribeToConversation: vi.fn(() => () => {}),
}));
vi.mock('./services/WidgetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/WidgetService')>();
  return { ...actual, authenticateWidget: vi.fn() };
});

import { createHttpApp } from './HttpServer';
import * as WidgetService from './services/WidgetService';
import * as WidgetChatService from './services/WidgetChatService';
import * as ServerService from './services/ServerService';

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
const ANON = {
  projectId: 'proj-1',
  projectSlug: 'proj-1-slug',
  authenticated: false,
  permissions: new Set<string>(),
  matchedRoles: [],
  authSource: 'anon' as const,
};

const CONV = {
  id: '11111111-1111-4111-a111-111111111111',
  widgetProjectId: 'proj-1',
  widgetUserId: 'wu-1',
  status: 'active',
  createdTaskId: null,
  userTurnCount: 0,
  pendingTurnId: null,
  createdAt: new Date('2026-06-07T00:00:00Z'),
  updatedAt: new Date('2026-06-07T00:00:00Z'),
};
const MSG = {
  id: '22222222-2222-4222-a222-222222222222',
  conversationId: CONV.id,
  role: 'user',
  content: 'hi',
  payload: null,
  turnId: null,
  seq: null,
  createdAt: new Date('2026-06-07T00:00:01Z'),
};

describe('POST /api/widget/chat/conversations', () => {
  beforeEach(() => vi.resetAllMocks());

  it('401 when authenticateWidget returns null', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(null as any);
    const res = await makeApp().request('/api/widget/chat/conversations', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('403 for anonymous viewers (same gating as ticket submission)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(ANON as any);
    const res = await makeApp().request('/api/widget/chat/conversations', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('identified_user_required');
  });

  it('200 with conversation + serialized messages', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.getOrCreateActiveConversation).mockResolvedValue({
      conversation: CONV, messages: [MSG],
    } as any);
    const res = await makeApp().request('/api/widget/chat/conversations', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation).toMatchObject({ id: CONV.id, status: 'active', userTurnCount: 0 });
    expect(body.messages[0]).toMatchObject({ id: MSG.id, role: 'user', content: 'hi' });
    expect(typeof body.messages[0].createdAt).toBe('string');
  });

  it('maps WidgetError codes (chat_not_enabled → 404)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.getOrCreateActiveConversation).mockRejectedValue(
      new WidgetService.WidgetError('chat_not_enabled', 404),
    );
    const res = await makeApp().request('/api/widget/chat/conversations', { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('chat_not_enabled');
  });
});

describe('GET /api/widget/chat/conversations/active', () => {
  beforeEach(() => vi.resetAllMocks());

  it('404 when there is no active conversation', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.getActiveConversation).mockResolvedValue(null);
    const res = await makeApp().request('/api/widget/chat/conversations/active');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/widget/chat/conversations/:id/messages', () => {
  beforeEach(() => vi.resetAllMocks());

  it('400 when content is missing', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('passes content through and returns the appended message', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.sendUserMessage).mockResolvedValue(MSG as any);
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(WidgetChatService.sendUserMessage).toHaveBeenCalledWith(CONV.id, 'proj-1', 'wu-1', 'hi');
    expect((await res.json()).message.content).toBe('hi');
  });

  it('maps turn_limit_reached → 409', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.sendUserMessage).mockRejectedValue(
      new WidgetService.WidgetError('turn_limit_reached', 409),
    );
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('turn_limit_reached');
  });
});

describe('POST /api/widget/chat/conversations/:id/create-ticket', () => {
  beforeEach(() => vi.resetAllMocks());

  it('forwards the edited draft and returns the ticketId', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.createTicketFromChat).mockResolvedValue({ ticketId: 'tk-9' });
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/create-ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', description: 'D' }),
    });
    expect(res.status).toBe(200);
    expect(WidgetChatService.createTicketFromChat).toHaveBeenCalledWith(
      CONV.id, 'proj-1', 'wu-1', { title: 'T', description: 'D' },
    );
    expect((await res.json()).ticketId).toBe('tk-9');
  });
});

describe('POST /api/widget/chat/conversations/:id/submit-ticket', () => {
  beforeEach(() => vi.resetAllMocks());

  it('403 for anonymous viewers (same gate as the other chat routes)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(ANON as any);
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/submit-ticket`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(WidgetChatService.submitTicketFromConversation).not.toHaveBeenCalled();
  });

  it('takes NO body — the draft is derived server-side — and returns the ticketId', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.submitTicketFromConversation).mockResolvedValue({ ticketId: 'tk-7' });
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/submit-ticket`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(WidgetChatService.submitTicketFromConversation).toHaveBeenCalledWith(CONV.id, 'proj-1', 'wu-1');
    expect((await res.json()).ticketId).toBe('tk-7');
  });

  it('maps the distinct 409 codes (agent_turns_present)', async () => {
    vi.mocked(WidgetService.authenticateWidget).mockResolvedValue(IDENTIFIED as any);
    vi.mocked(WidgetChatService.submitTicketFromConversation).mockRejectedValue(
      new WidgetService.WidgetError('agent_turns_present', 409),
    );
    const res = await makeApp().request(`/api/widget/chat/conversations/${CONV.id}/submit-ticket`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('agent_turns_present');
  });
});

describe('POST /api/internal/widget-chat/events', () => {
  beforeEach(() => vi.resetAllMocks());

  const EVENTS_BODY = {
    serverId: 'srv-1', conversationId: CONV.id, turnId: '33333333-3333-4333-a333-333333333333',
    events: [{ seq: 0, kind: 'agent_message', text: 'yo' }],
  };

  it('401 without X-Server-Token', async () => {
    const res = await makeApp().request('/api/internal/widget-chat/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(EVENTS_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('403 when the token resolves to a different server than body.serverId', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue({ id: 'srv-OTHER' } as any);
    const res = await makeApp().request('/api/internal/widget-chat/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Server-Token': 'tok' },
      body: JSON.stringify(EVENTS_BODY),
    });
    expect(res.status).toBe(403);
  });

  it('200 and forwards to ingestTurnEvents on a valid request', async () => {
    vi.mocked(ServerService.getServerByToken).mockResolvedValue({ id: 'srv-1' } as any);
    vi.mocked(WidgetChatService.ingestTurnEvents).mockResolvedValue({ inserted: 1, turnDone: false });
    const res = await makeApp().request('/api/internal/widget-chat/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Server-Token': 'tok' },
      body: JSON.stringify(EVENTS_BODY),
    });
    expect(res.status).toBe(200);
    expect(WidgetChatService.ingestTurnEvents).toHaveBeenCalledWith('srv-1', {
      conversationId: EVENTS_BODY.conversationId,
      turnId: EVENTS_BODY.turnId,
      events: EVENTS_BODY.events,
    });
    expect((await res.json()).ok).toBe(true);
  });
});
