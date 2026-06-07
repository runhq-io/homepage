/**
 * Route-level wiring tests for the team Conversations inbox
 * (/api/widget/team/*): workspace-member auth (401 no/bad token, 403
 * non-member — cross-tenant included), param/body validation, WidgetError →
 * HTTP mapping, and reply attribution (session member's display name).
 * Behavior is service-tested against the real DB; here services are mocked.
 */
import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({ createToken: vi.fn(), verifyToken: vi.fn(), extractUserIdFromToken: vi.fn() }));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  checkServerPermission: vi.fn(),
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
  listTeamConversations: vi.fn(),
  getTeamConversation: vi.fn(),
  getTeamConversationServerId: vi.fn(),
  sendTeamReply: vi.fn(),
}));

import { createHttpApp } from './HttpServer';
import { extractUserIdFromToken } from './auth/jwt';
import * as ServerService from './services/ServerService';
import * as WidgetService from './services/WidgetService';
import * as WidgetChatService from './services/WidgetChatService';

const makeApp = () => createHttpApp();

const MEMBER_ID = '99999999-9999-4999-a999-999999999999';
const CONV_ID = '11111111-1111-4111-a111-111111111111';
const SERVER_ID = 'ws_team_route';

const SUMMARY = {
  id: CONV_ID,
  userDisplay: 'Visitor Vera',
  lastMessagePreview: 'Newest words',
  messageCount: 3,
  status: 'active',
  createdTaskId: null,
  hasAgentTurns: false,
  createdAt: '2026-06-07T00:00:00.000Z',
  updatedAt: '2026-06-07T00:00:01.000Z',
};
const TEAM_MSG = {
  id: '22222222-2222-4222-a222-222222222222',
  conversationId: CONV_ID,
  role: 'team',
  content: 'On it!',
  payload: { authorName: 'Team' },
  turnId: null,
  seq: null,
  createdAt: new Date('2026-06-07T00:00:02Z'),
};

function asMember() {
  vi.mocked(extractUserIdFromToken).mockResolvedValue(MEMBER_ID);
  vi.mocked(ServerService.checkServerPermission).mockResolvedValue(true);
}

const AUTHED = { headers: { Authorization: 'Bearer session-token' } };

describe('GET /api/widget/team/conversations', () => {
  beforeEach(() => vi.resetAllMocks());

  it('400 without serverId / projectId', async () => {
    asMember();
    const noServer = await makeApp().request('/api/widget/team/conversations?projectId=p1', AUTHED);
    expect(noServer.status).toBe(400);
    const noProject = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}`, AUTHED);
    expect(noProject.status).toBe(400);
  });

  it('401 without a bearer token, 401 for an invalid token', async () => {
    const anon = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}&projectId=p1`);
    expect(anon.status).toBe(401);
    vi.mocked(extractUserIdFromToken).mockResolvedValue(null as any);
    const bad = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}&projectId=p1`, AUTHED);
    expect(bad.status).toBe(401);
  });

  it('403 for non-members (cross-tenant)', async () => {
    vi.mocked(extractUserIdFromToken).mockResolvedValue(MEMBER_ID);
    vi.mocked(ServerService.checkServerPermission).mockResolvedValue(false);
    const res = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}&projectId=p1`, AUTHED);
    expect(res.status).toBe(403);
    expect(vi.mocked(ServerService.checkServerPermission)).toHaveBeenCalledWith(
      SERVER_ID, MEMBER_ID, ['owner', 'member'],
    );
  });

  it('200 with the summaries, passed through verbatim', async () => {
    asMember();
    vi.mocked(WidgetChatService.listTeamConversations).mockResolvedValue([SUMMARY] as any);
    const res = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}&projectId=p1`, AUTHED);
    expect(res.status).toBe(200);
    expect((await res.json()).conversations).toEqual([SUMMARY]);
    expect(vi.mocked(WidgetChatService.listTeamConversations)).toHaveBeenCalledWith(SERVER_ID, 'p1');
  });

  it('maps WidgetError codes (project_not_found → 404)', async () => {
    asMember();
    vi.mocked(WidgetChatService.listTeamConversations).mockRejectedValue(
      new WidgetService.WidgetError('project_not_found', 404),
    );
    const res = await makeApp().request(`/api/widget/team/conversations?serverId=${SERVER_ID}&projectId=p1`, AUTHED);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('project_not_found');
  });
});

describe('GET /api/widget/team/conversations/:id', () => {
  beforeEach(() => vi.resetAllMocks());

  it('404 for unknown conversations BEFORE auth resolution (no membership oracle)', async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(null);
    const res = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}`, AUTHED);
    expect(res.status).toBe(404);
    expect(vi.mocked(ServerService.checkServerPermission)).not.toHaveBeenCalled();
  });

  it('403 when the session user is not a member of the conversation server', async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(SERVER_ID);
    vi.mocked(extractUserIdFromToken).mockResolvedValue(MEMBER_ID);
    vi.mocked(ServerService.checkServerPermission).mockResolvedValue(false);
    const res = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}`, AUTHED);
    expect(res.status).toBe(403);
  });

  it('200 with the summary + serialized full thread', async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(SERVER_ID);
    asMember();
    vi.mocked(WidgetChatService.getTeamConversation).mockResolvedValue({
      conversation: SUMMARY, messages: [TEAM_MSG],
    } as any);
    const res = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}`, AUTHED);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation).toEqual(SUMMARY);
    expect(body.messages[0]).toMatchObject({
      id: TEAM_MSG.id, role: 'team', content: 'On it!', payload: { authorName: 'Team' },
    });
    expect(typeof body.messages[0].createdAt).toBe('string');
  });
});

describe('POST /api/widget/team/conversations/:id/reply', () => {
  beforeEach(() => vi.resetAllMocks());

  it('404 unknown conversation / 403 non-member / 400 missing content', async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(null);
    const unknown = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}/reply`, {
      method: 'POST', headers: { ...AUTHED.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(unknown.status).toBe(404);

    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(SERVER_ID);
    vi.mocked(extractUserIdFromToken).mockResolvedValue(MEMBER_ID);
    vi.mocked(ServerService.checkServerPermission).mockResolvedValue(false);
    const forbidden = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}/reply`, {
      method: 'POST', headers: { ...AUTHED.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(forbidden.status).toBe(403);

    asMember();
    const noContent = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}/reply`, {
      method: 'POST', headers: { ...AUTHED.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noContent.status).toBe(400);
    expect(vi.mocked(WidgetChatService.sendTeamReply)).not.toHaveBeenCalled();
  });

  it("200: appends via sendTeamReply with the member's display-name fallback", async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(SERVER_ID);
    asMember();
    vi.mocked(WidgetChatService.sendTeamReply).mockResolvedValue(TEAM_MSG as any);
    const res = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}/reply`, {
      method: 'POST', headers: { ...AUTHED.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'On it!' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatchObject({ role: 'team', content: 'On it!' });
    // MEMBER_ID has no users row in the scratch DB → display-name falls back
    // to 'Team'. (Real-name attribution = users.name ?? email, same select
    // the widget settings token route uses.)
    expect(vi.mocked(WidgetChatService.sendTeamReply)).toHaveBeenCalledWith(
      SERVER_ID, CONV_ID, 'Team', 'On it!',
    );
  });

  it('maps WidgetError codes (conversation_closed → 409)', async () => {
    vi.mocked(WidgetChatService.getTeamConversationServerId).mockResolvedValue(SERVER_ID);
    asMember();
    vi.mocked(WidgetChatService.sendTeamReply).mockRejectedValue(
      new WidgetService.WidgetError('conversation_closed', 409),
    );
    const res = await makeApp().request(`/api/widget/team/conversations/${CONV_ID}/reply`, {
      method: 'POST', headers: { ...AUTHED.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('conversation_closed');
  });
});
