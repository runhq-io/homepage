/**
 * Agentless conversations: when widget_chat_agent_entity_id is null the chat
 * backbone still accepts conversation start + user messages — it just skips
 * turn dispatch entirely (no pending_turn_id, no workspace call). After the
 * FIRST user message BE appends a single role='event' {kind:'collect_prompt'}
 * row (idempotent). If an agent is configured later, the next user message in
 * a still-open conversation dispatches a turn normally. Runs against the
 * scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
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
const SERVER_ID = `ws_chatagentless_${RUN_HEX}`;
const USER_ID = `00000000-000e-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string; // agentless (no support agent configured)
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `al+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatAgentless ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatagentless_${RUN_HEX}`,
    name: `ChatAgentless ${RUN_HEX}`,
    slug: `chatagentless-${RUN_HEX}`,
    apiKey: `apikey-al-${RUN_HEX}`,
    apiSecretHash: `secret-al-${RUN_HEX}`,
    channelId: `ch_al_${RUN_HEX}`,
    // widgetChatAgentEntityId intentionally NULL — agentless intake
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-al-${RUN_HEX}`, name: 'Agentless User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  vi.mocked(ServerService.serverTokenFetch).mockReset();
  vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({ ok: true } as any);
  // Reset to agentless between tests (the configured-later test flips it on).
  await db.update(widgetProjects)
    .set({ widgetChatAgentEntityId: null })
    .where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
});

async function collectPromptRows(conversationId: string) {
  return db.select().from(widgetChatMessages).where(and(
    eq(widgetChatMessages.conversationId, conversationId),
    sql`${widgetChatMessages.payload}->>'kind' = 'collect_prompt'`,
  ));
}

describe('agentless conversations', () => {
  it('getOrCreateActiveConversation works without a configured agent', async () => {
    const { conversation, messages, hasAgentTurns } =
      await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    expect(conversation.status).toBe('active');
    expect(messages).toEqual([]);
    expect(hasAgentTurns).toBe(false);
  });

  it('sendUserMessage skips turn dispatch entirely (no workspace call, no pending_turn_id)', async () => {
    const { conversation } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    const msg = await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Hello there');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello there');
    expect(ServerService.serverTokenFetch).not.toHaveBeenCalled();

    const [fresh] = await db.select().from(widgetChatConversations)
      .where(eq(widgetChatConversations.id, conversation.id));
    expect(fresh!.pendingTurnId).toBeNull();
    expect(fresh!.userTurnCount).toBe(1);
  });

  it('appends collect_prompt exactly once after the first user message', async () => {
    const { conversation } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'First message');

    let prompts = await collectPromptRows(conversation.id);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.role).toBe('event');
    expect(prompts[0]!.payload).toEqual({ kind: 'collect_prompt' });

    // Subsequent messages do NOT re-add it.
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Second message');
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Third message');
    prompts = await collectPromptRows(conversation.id);
    expect(prompts).toHaveLength(1);

    // Transcript order: the collect_prompt sits right after the first message.
    const all = await WidgetChatService.listMessages(conversation.id, PROJECT_ID, WIDGET_USER_ID, new Set());
    expect(all.map((m) => m.role)).toEqual(['user', 'event', 'user', 'user']);
  });

  it('publishes the collect_prompt onto the SSE stream', async () => {
    const { conversation } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    const seen: WidgetChatService.ChatMessageRow[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(conversation.id, (row) => seen.push(row));
    try {
      await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Hi');
    } finally {
      unsubscribe();
    }
    expect(seen.map((r) => r.role)).toEqual(['user', 'event']);
    expect(seen[1]!.payload).toEqual({ kind: 'collect_prompt' });
  });

  it('dispatches a turn normally once an agent is configured later (and never re-adds collect_prompt)', async () => {
    const { conversation } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Pre-agent message');
    expect(ServerService.serverTokenFetch).not.toHaveBeenCalled();

    await db.update(widgetProjects)
      .set({ widgetChatAgentEntityId: 'ae_late_support' })
      .where(eq(widgetProjects.id, PROJECT_ID));

    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Post-agent message');
    expect(ServerService.serverTokenFetch).toHaveBeenCalledTimes(1);
    const body = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]![2] as any;
    expect(body.agentEntityId).toBe('ae_late_support');
    // The transcript carries the pre-agent history (user + collect_prompt event + user).
    expect(body.transcript.map((t: any) => t.role)).toEqual(['user', 'event', 'user']);

    const [fresh] = await db.select().from(widgetChatConversations)
      .where(eq(widgetChatConversations.id, conversation.id));
    expect(fresh!.pendingTurnId).not.toBeNull();
    expect(await collectPromptRows(conversation.id)).toHaveLength(1);
  });

  it('reports hasAgentTurns=true once a turn exists (pending or persisted rows)', async () => {
    const { conversation } = await WidgetChatService.getOrCreateActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Hello');
    let bundle = await WidgetChatService.getActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    expect(bundle!.hasAgentTurns).toBe(false);

    await db.update(widgetProjects)
      .set({ widgetChatAgentEntityId: 'ae_late_support' })
      .where(eq(widgetProjects.id, PROJECT_ID));
    await WidgetChatService.sendUserMessage(conversation.id, PROJECT_ID, WIDGET_USER_ID, 'Again');

    bundle = await WidgetChatService.getActiveConversation(PROJECT_ID, WIDGET_USER_ID);
    expect(bundle!.hasAgentTurns).toBe(true);
  });
});
