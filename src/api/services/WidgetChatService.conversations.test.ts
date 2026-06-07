/**
 * Conversation lifecycle + privacy scoping: create-or-resume, active lookup,
 * owner-scoped reads (conversation_not_found for non-owners — existence never
 * leaks), message listing with the `after` cursor, and the last-50 resume
 * window. Runs against the scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatconv_${RUN_HEX}`;
const USER_ID = `00000000-000d-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;      // chat enabled (support agent configured)
let BARE_PROJECT_ID: string; // chat disabled (no support agent)
let OWNER_ID: string;
let STRANGER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `cc+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatConv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatconv_${RUN_HEX}`,
    name: `ChatConv ${RUN_HEX}`,
    slug: `chatconv-${RUN_HEX}`,
    apiKey: `apikey-cc-${RUN_HEX}`,
    apiSecretHash: `secret-cc-${RUN_HEX}`,
    channelId: `ch_cc_${RUN_HEX}`,
    widgetChatAgentEntityId: 'ae_support',
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [bare] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatconv_bare_${RUN_HEX}`,
    name: `ChatConv Bare ${RUN_HEX}`,
    slug: `chatconv-bare-${RUN_HEX}`,
    apiKey: `apikey-ccb-${RUN_HEX}`,
    apiSecretHash: `secret-ccb-${RUN_HEX}`,
    channelId: `ch_ccb_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  BARE_PROJECT_ID = bare!.id;
  const [owner] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-own-${RUN_HEX}`, name: 'Owner',
  }).returning({ id: widgetUsers.id });
  OWNER_ID = owner!.id;
  const [stranger] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-str-${RUN_HEX}`, name: 'Stranger',
  }).returning({ id: widgetUsers.id });
  STRANGER_ID = stranger!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, BARE_PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
});

async function seedConversation(widgetUserId = OWNER_ID) {
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId,
  }).returning();
  return conv!;
}

async function seedMessage(conversationId: string, content: string) {
  const [row] = await db.insert(widgetChatMessages).values({
    conversationId, role: 'user', content,
  }).returning();
  return row!;
}

describe('getOrCreateActiveConversation', () => {
  it('creates an agentless conversation when no support agent is configured', async () => {
    // Agentless intake rides the same backbone — start succeeds; turn
    // dispatch is skipped at send time (see WidgetChatService.agentless.test.ts).
    const { conversation, hasAgentTurns } =
      await WidgetChatService.getOrCreateActiveConversation(BARE_PROJECT_ID, OWNER_ID);
    expect(conversation).toMatchObject({
      widgetProjectId: BARE_PROJECT_ID, widgetUserId: OWNER_ID, status: 'active',
    });
    expect(hasAgentTurns).toBe(false);
    await db.delete(widgetChatConversations).where(eq(widgetChatConversations.id, conversation.id));
  });

  it('creates a fresh active conversation with no messages', async () => {
    const { conversation, messages } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, OWNER_ID);
    expect(conversation).toMatchObject({
      widgetProjectId: PROJECT_ID,
      widgetUserId: OWNER_ID,
      status: 'active',
      userTurnCount: 0,
    });
    expect(messages).toEqual([]);
  });

  it('resumes the existing active conversation with the last 50 messages, oldest first', async () => {
    const conv = await seedConversation();
    for (let i = 0; i < 60; i++) await seedMessage(conv.id, `m${i}`);
    const { conversation, messages } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, OWNER_ID);
    expect(conversation.id).toBe(conv.id);
    expect(messages).toHaveLength(50);
    expect(messages[0]!.content).toBe('m10');
    expect(messages[49]!.content).toBe('m59');
  });
});

describe('getActiveConversation', () => {
  it('returns null when none, the bundle when active, and null again once closed', async () => {
    expect(await WidgetChatService.getActiveConversation(PROJECT_ID, OWNER_ID)).toBeNull();
    const conv = await seedConversation();
    await seedMessage(conv.id, 'hello');
    const bundle = await WidgetChatService.getActiveConversation(PROJECT_ID, OWNER_ID);
    expect(bundle!.conversation.id).toBe(conv.id);
    expect(bundle!.messages.map((m) => m.content)).toEqual(['hello']);
    await db.update(widgetChatConversations).set({ status: 'closed' })
      .where(eq(widgetChatConversations.id, conv.id));
    expect(await WidgetChatService.getActiveConversation(PROJECT_ID, OWNER_ID)).toBeNull();
  });
});

describe('getConversationOwned (privacy scoping)', () => {
  it('404s identically for missing, foreign-user, wrong-project, and malformed ids', async () => {
    const conv = await seedConversation();
    const expected = { code: 'conversation_not_found', status: 404 };
    await expect(WidgetChatService.getConversationOwned(randomUUID(), PROJECT_ID, OWNER_ID)).rejects.toMatchObject(expected);
    await expect(WidgetChatService.getConversationOwned(conv.id, PROJECT_ID, STRANGER_ID)).rejects.toMatchObject(expected);
    await expect(WidgetChatService.getConversationOwned(conv.id, BARE_PROJECT_ID, OWNER_ID)).rejects.toMatchObject(expected);
    await expect(WidgetChatService.getConversationOwned('not-a-uuid', PROJECT_ID, OWNER_ID)).rejects.toMatchObject(expected);
    await expect(WidgetChatService.getConversationOwned(conv.id, PROJECT_ID, OWNER_ID)).resolves.toMatchObject({ id: conv.id });
  });
});

describe('listMessages', () => {
  it('returns the full transcript in order without a cursor', async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, 'a');
    await seedMessage(conv.id, 'b');
    const rows = await WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID);
    expect(rows.map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('returns only rows strictly after the cursor', async () => {
    const conv = await seedConversation();
    const a = await seedMessage(conv.id, 'a');
    await seedMessage(conv.id, 'b');
    const c = await seedMessage(conv.id, 'c');
    const afterA = await WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, a.id);
    expect(afterA.map((m) => m.content)).toEqual(['b', 'c']);
    expect(await WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, c.id)).toEqual([]);
  });

  it('400s invalid_cursor for unknown or malformed cursors', async () => {
    const conv = await seedConversation();
    await expect(WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, randomUUID()))
      .rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
    await expect(WidgetChatService.listMessages(conv.id, PROJECT_ID, OWNER_ID, 'nope'))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('enforces ownership before reading', async () => {
    const conv = await seedConversation();
    await expect(WidgetChatService.listMessages(conv.id, PROJECT_ID, STRANGER_ID))
      .rejects.toMatchObject({ code: 'conversation_not_found' });
  });
});
