/**
 * Team side of widget chat: role='team' replies from workspace members
 * (payload {authorName}), delivered over the same SSE/polling transport as
 * agent messages, NEVER dispatching a turn — plus the server-scoped inbox
 * accessors (list/detail) behind /api/widget/team/*. Cross-tenant access
 * answers conversation_not_found/project_not_found, never an existence
 * signal. Runs against the scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';
import * as ServerService from './ServerService';

vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn(),
}));

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatteam_${RUN_HEX}`;
const OTHER_SERVER_ID = `ws_chatteam_other_${RUN_HEX}`;
const USER_ID = `00000000-0010-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const WORKSPACE_PROJECT_ID = `wsp_chatteam_${RUN_HEX}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `tm+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatTeam ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  await db.insert(servers).values({ id: OTHER_SERVER_ID, name: `ChatTeam Other ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    name: `ChatTeam ${RUN_HEX}`,
    slug: `chatteam-${RUN_HEX}`,
    apiKey: `apikey-tm-${RUN_HEX}`,
    apiSecretHash: `secret-tm-${RUN_HEX}`,
    channelId: `ch_tm_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-tm-${RUN_HEX}`, name: 'Visitor Vera',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, OTHER_SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  vi.mocked(ServerService.serverTokenFetch).mockReset();
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
});

async function seedConversation(overrides: Partial<typeof widgetChatConversations.$inferInsert> = {}) {
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, ...overrides,
  }).returning();
  return conv!;
}

async function seedMessage(
  conversationId: string,
  values: Partial<typeof widgetChatMessages.$inferInsert> & Pick<typeof widgetChatMessages.$inferInsert, 'role'>,
) {
  const [row] = await db.insert(widgetChatMessages).values({
    conversationId, content: '', ...values,
  }).returning();
  return row!;
}

describe('sendTeamReply', () => {
  it("appends a role='team' row with {authorName}, publishes to SSE, and never dispatches a turn", async () => {
    const conv = await seedConversation();
    const seen: WidgetChatService.ChatMessageRow[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(conv.id, (row) => seen.push(row));
    let reply: WidgetChatService.ChatMessageRow;
    try {
      reply = await WidgetChatService.sendTeamReply(SERVER_ID, conv.id, 'Support Sam', "We're on it!");
    } finally {
      unsubscribe();
    }

    expect(reply.role).toBe('team');
    expect(reply.content).toBe("We're on it!");
    expect(reply.payload).toEqual({ authorName: 'Support Sam' });
    expect(seen.map((r) => r.id)).toEqual([reply.id]);

    // Round-trips through the widget-side listing like any other message.
    const all = await WidgetChatService.listMessages(conv.id, PROJECT_ID, WIDGET_USER_ID);
    expect(all.map((m) => m.role)).toEqual(['team']);

    // No turn machinery touched.
    expect(ServerService.serverTokenFetch).not.toHaveBeenCalled();
    const [fresh] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, conv.id));
    expect(fresh!.pendingTurnId).toBeNull();
    expect(fresh!.userTurnCount).toBe(0);
  });

  it('bumps the conversation updated_at (inbox sort key)', async () => {
    const conv = await seedConversation({ updatedAt: new Date('2026-01-01T00:00:00Z') });
    await WidgetChatService.sendTeamReply(SERVER_ID, conv.id, 'Support Sam', 'ping');
    const [fresh] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, conv.id));
    expect(fresh!.updatedAt.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('validates content: 1-4000 chars', async () => {
    const conv = await seedConversation();
    await expect(WidgetChatService.sendTeamReply(SERVER_ID, conv.id, 'Sam', '   '))
      .rejects.toMatchObject({ code: 'message_required', status: 400 });
    await expect(WidgetChatService.sendTeamReply(SERVER_ID, conv.id, 'Sam', 'x'.repeat(4001)))
      .rejects.toMatchObject({ code: 'message_too_long', status: 400 });
  });

  it('409s conversation_closed on closed conversations', async () => {
    const conv = await seedConversation({ status: 'closed' });
    await expect(WidgetChatService.sendTeamReply(SERVER_ID, conv.id, 'Sam', 'hello'))
      .rejects.toMatchObject({ code: 'conversation_closed', status: 409 });
  });

  it('404s conversation_not_found cross-tenant (existence never leaks)', async () => {
    const conv = await seedConversation();
    await expect(WidgetChatService.sendTeamReply(OTHER_SERVER_ID, conv.id, 'Sam', 'hello'))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    await expect(WidgetChatService.sendTeamReply(SERVER_ID, randomUUID(), 'Sam', 'hello'))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });
});

describe('listTeamConversations', () => {
  it('lists newest-first with userDisplay, preview, counts, status, and hasAgentTurns', async () => {
    const older = await seedConversation({
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    await seedMessage(older.id, { role: 'user', content: 'Older question' });
    await seedMessage(older.id, { role: 'agent', content: 'Agent answer', turnId: randomUUID(), seq: 0 });

    const newer = await seedConversation({
      status: 'closed', createdTaskId: randomUUID(),
      createdAt: new Date('2026-01-03T00:00:00Z'), updatedAt: new Date('2026-01-04T00:00:00Z'),
    });
    await seedMessage(newer.id, { role: 'user', content: 'Newer question' });
    await seedMessage(newer.id, { role: 'event', payload: { kind: 'collect_prompt' } });
    await seedMessage(newer.id, { role: 'team', content: 'Team reply here', payload: { authorName: 'Sam' } });

    const list = await WidgetChatService.listTeamConversations(SERVER_ID, WORKSPACE_PROJECT_ID);
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);

    const [n, o] = list;
    expect(n).toMatchObject({
      userDisplay: 'Visitor Vera',
      lastMessagePreview: 'Team reply here',
      messageCount: 2, // user + team; events don't count
      status: 'closed',
      hasAgentTurns: false,
    });
    expect(n!.createdTaskId).toBe(newer.createdTaskId);
    expect(typeof n!.updatedAt).toBe('string');

    expect(o).toMatchObject({
      userDisplay: 'Visitor Vera',
      lastMessagePreview: 'Agent answer',
      messageCount: 2,
      status: 'active',
      createdTaskId: null,
      hasAgentTurns: true,
    });
  });

  it('scopes by server: project_not_found for the wrong server', async () => {
    await expect(WidgetChatService.listTeamConversations(OTHER_SERVER_ID, WORKSPACE_PROJECT_ID))
      .rejects.toMatchObject({ code: 'project_not_found', status: 404 });
  });
});

describe('getTeamConversation', () => {
  it('returns the conversation summary plus the FULL transcript (all roles + events)', async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, { role: 'user', content: 'Question' });
    await seedMessage(conv.id, { role: 'event', payload: { kind: 'collect_prompt' } });
    await seedMessage(conv.id, { role: 'team', content: 'Answer', payload: { authorName: 'Sam' } });

    const detail = await WidgetChatService.getTeamConversation(SERVER_ID, conv.id);
    expect(detail.conversation.id).toBe(conv.id);
    expect(detail.conversation.userDisplay).toBe('Visitor Vera');
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'event', 'team']);
    expect(detail.messages[2]!.payload).toEqual({ authorName: 'Sam' });
  });

  it('404s conversation_not_found cross-tenant', async () => {
    const conv = await seedConversation();
    await expect(WidgetChatService.getTeamConversation(OTHER_SERVER_ID, conv.id))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });
});
