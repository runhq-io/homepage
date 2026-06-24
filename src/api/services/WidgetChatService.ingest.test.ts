/**
 * Idempotent workspace→BE event ingestion: cross-tenant guard, (turn_id, seq)
 * upsert idempotency, ticket_link/assigned enrichment from the synced
 * mirrors, turn_error notices, and turn_done bookkeeping (pending-turn clear,
 * late-completion notice removal, close-on-created). Runs against the
 * scratch Postgres.
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
  widgetExposedAgents,
  workspaceTasks,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatingest_${RUN_HEX}`;
const USER_ID = `00000000-000f-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;
let TASK_ID: string;
let PRIVATE_TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `ci+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatIngest ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatingest_${RUN_HEX}`,
    name: `ChatIngest ${RUN_HEX}`,
    slug: `chatingest-${RUN_HEX}`,
    apiKey: `apikey-ci-${RUN_HEX}`,
    apiSecretHash: `secret-ci-${RUN_HEX}`,
    channelId: `ch_ci_${RUN_HEX}`,
    widgetChatAgentEntityId: 'ae_support',
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-ci-${RUN_HEX}`, name: 'Ingest User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Linked task', sourceType: 'widget', createdByType: 'external',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;
  const [privateTask] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Internal security task', sourceType: 'workspace', createdByType: 'member',
    visibility: 'private',
  }).returning({ id: workspaceTasks.id });
  PRIVATE_TASK_ID = privateTask!.id;
  await db.insert(widgetExposedAgents).values({
    widgetProjectId: PROJECT_ID, agentId: 'ae_coder', agentName: 'Codey', agentDescription: null,
  }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

let CONV_ID: string;
let TURN_ID: string;

beforeEach(async () => {
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  TURN_ID = randomUUID();
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, pendingTurnId: TURN_ID,
  }).returning();
  CONV_ID = conv!.id;
});

const messages = () => db.select().from(widgetChatMessages)
  .where(eq(widgetChatMessages.conversationId, CONV_ID))
  .orderBy(widgetChatMessages.createdAt, widgetChatMessages.id);

describe('ingestTurnEvents', () => {
  it('404s conversation_not_found for unknown conversations and foreign servers', async () => {
    await expect(WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: randomUUID(), turnId: TURN_ID, events: [],
    })).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    await expect(WidgetChatService.ingestTurnEvents('ws_someone_else', {
      conversationId: CONV_ID, turnId: TURN_ID, events: [],
    })).rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });

  it('persists events in seq order, publishes them, and retries are no-ops', async () => {
    const events: WidgetChatService.TurnEventInput[] = [
      { seq: 1, kind: 'proposal', title: 'Fix exports', description: 'CSV export 500s', toolUseId: 'tu_1' },
      { seq: 0, kind: 'agent_message', text: 'Got it — proposing a ticket.' },
    ];
    const seen: string[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(CONV_ID, (row) => seen.push(row.role));
    const first = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID, events,
    });
    unsubscribe();
    expect(first).toEqual({ inserted: 2, turnDone: false });
    expect(seen).toEqual(['agent', 'event']); // seq order, not arrival order

    const rows = await messages();
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ role: 'agent', content: 'Got it — proposing a ticket.', turnId: TURN_ID });
    expect(rows[1]!.payload).toEqual({ kind: 'proposal', title: 'Fix exports', description: 'CSV export 500s', toolUseId: 'tu_1' });

    const retry = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID, events,
    });
    expect(retry).toEqual({ inserted: 0, turnDone: false });
    expect(await messages()).toHaveLength(2);
  });

  it('persists a team_message as a role=team row and publishes it (live chat → live session mirror)', async () => {
    const seen: string[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(CONV_ID, (row) => seen.push(row.role));
    const result = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [{ seq: 0, kind: 'team_message', text: 'Pushed a fix — can you re-test?' }],
    });
    unsubscribe();
    expect(result).toEqual({ inserted: 1, turnDone: false });
    expect(seen).toEqual(['team']);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'team', content: 'Pushed a fix — can you re-test?', turnId: TURN_ID });
  });

  it('drops an empty team_message (no text)', async () => {
    const result = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [{ seq: 0, kind: 'team_message' }],
    });
    expect(result).toEqual({ inserted: 0, turnDone: false });
    expect(await messages()).toHaveLength(0);
  });

  it('enriches ticket_link from the synced task store and drops unknown ticket ids', async () => {
    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'ticket_link', ticketId: TASK_ID },
        { seq: 1, kind: 'ticket_link', ticketId: randomUUID() }, // not a known task → dropped
        { seq: 2, kind: 'ticket_link', ticketId: 'not-a-uuid' }, // malformed → dropped
        { seq: 3, kind: 'ticket_link', ticketId: PRIVATE_TASK_ID }, // private → dropped, never leak titles to visitors
      ],
    });
    expect(res.inserted).toBe(1);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ kind: 'ticket_link', ticketId: TASK_ID, title: 'Linked task', status: 'pending' });
  });

  it('resolves assigned agent names from the exposed-agents mirror (null when unmirrored)', async () => {
    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_coder' },
        { seq: 1, kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_ghost' },
      ],
    });
    expect(res.inserted).toBe(2);
    const rows = await messages();
    expect(rows[0]!.payload).toEqual({ kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_coder', agentName: 'Codey' });
    expect(rows[1]!.payload).toEqual({ kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_ghost', agentName: null });
  });

  it('turn_error appends a turn_failed notice and completes the turn', async () => {
    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [{ seq: 0, kind: 'turn_error', message: 'model exploded' }],
    });
    expect(res).toEqual({ inserted: 1, turnDone: false });
    const rows = await messages();
    expect(rows[0]!.payload).toEqual({ kind: 'system_notice', code: 'turn_failed', text: 'model exploded' });
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'active', pendingTurnId: null });
  });

  it('a stale superseded turn_done does NOT close a created conversation while the post-create turn is pending', async () => {
    // Race (live-repro 2026-06-07): the user sends messages mid-turn, so
    // several turns run concurrently. They click [Create Ticket] while a
    // stale clarification turn is still in flight; createTicketFromChat sets
    // createdTaskId and dispatches the post-create turn (pendingTurnId now
    // points at it). The STALE turn then finishes — its turn_done must NOT
    // close the conversation, or the post-create turn's assigned/wrap-up
    // rows land invisibly after the widget's closed-watch kills the
    // transport.
    const postCreateTurnId = randomUUID();
    await db.update(widgetChatConversations)
      .set({ createdTaskId: TASK_ID, pendingTurnId: postCreateTurnId })
      .where(eq(widgetChatConversations.id, CONV_ID));

    // Stale turn (TURN_ID) completes — conversation must stay active.
    const stale = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'agent_message', text: 'Answering an already-superseded question.' },
        { seq: 1, kind: 'turn_done' },
      ],
    });
    expect(stale).toEqual({ inserted: 1, turnDone: true });
    let [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'active', pendingTurnId: postCreateTurnId });

    // The post-create turn completes — NOW the conversation closes.
    const real = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: postCreateTurnId,
      events: [
        { seq: 0, kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_coder' },
        { seq: 1, kind: 'agent_message', text: 'All done — handed off to Codey.' },
        { seq: 2, kind: 'turn_done' },
      ],
    });
    expect(real).toEqual({ inserted: 2, turnDone: true });
    [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'closed', pendingTurnId: null });
  });

  it('late turn_done replaces the agent_unavailable notice and closes a created conversation', async () => {
    // Simulate a timed-out turn the BE already noticed, on a conversation
    // whose ticket was created (close-on-turn_done contract).
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'event', turnId: TURN_ID, seq: null,
      payload: { kind: 'system_notice', code: 'agent_unavailable', text: 'unavailable' },
    });
    await db.update(widgetChatConversations).set({ createdTaskId: TASK_ID })
      .where(eq(widgetChatConversations.id, CONV_ID));

    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'agent_message', text: 'Created your ticket — assigning it now.' },
        { seq: 1, kind: 'turn_done' },
      ],
    });
    expect(res).toEqual({ inserted: 1, turnDone: true });

    const rows = await messages();
    expect(rows).toHaveLength(1); // notice deleted, late reply kept
    expect(rows[0]).toMatchObject({ role: 'agent', content: 'Created your ticket — assigning it now.' });

    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'closed', pendingTurnId: null });
  });
});
