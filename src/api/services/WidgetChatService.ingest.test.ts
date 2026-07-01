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
    // No author supplied → null payload, so the widget falls back to "Team".
    expect(rows[0]!.payload).toBeNull();
  });

  it('attributes a team_message to its author (multiple staff in a live session)', async () => {
    // The live-chat → live-session mirror carries the workspace member's display
    // name so a session with several staff shows each sender's name, not "Team".
    const result = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [{ seq: 0, kind: 'team_message', text: 'On it — deploying now.', authorName: '  Suha  ' }],
    });
    expect(result).toEqual({ inserted: 1, turnDone: false });
    const rows = await messages();
    expect(rows).toHaveLength(1);
    // Same {authorName} shape sendTeamReply uses; trimmed before persisting.
    expect(rows[0]).toMatchObject({ role: 'team', content: 'On it — deploying now.', payload: { authorName: 'Suha' } });
  });

  it('falls back to a null payload when team_message authorName is blank', async () => {
    const result = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [{ seq: 0, kind: 'team_message', text: 'Whitespace author', authorName: '   ' }],
    });
    expect(result).toEqual({ inserted: 1, turnDone: false });
    const rows = await messages();
    expect(rows[0]!.payload).toBeNull();
  });

  it('per-message turn ids: same seq + different turn ids both persist; same turn id dedups (mirror convergence contract)', async () => {
    // The live-coder mirror sends each message as its own turn id `lc:<originId>`
    // with seq 0. The global (turn_id, seq) unique index must therefore NOT
    // collide two distinct messages that happen to share seq 0 — and MUST dedup
    // a re-sent message with the same turn id. This is what makes the mirror
    // provably convergent (idempotent + collision-free) instead of silently
    // dropping messages the way the old constant-turnId + resettable-seq did.
    const a = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: 'lc:msgA', events: [{ seq: 0, kind: 'agent_message', text: 'first' }],
    });
    const b = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: 'lc:msgB', events: [{ seq: 0, kind: 'agent_message', text: 'second' }],
    });
    const dup = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: 'lc:msgA', events: [{ seq: 0, kind: 'agent_message', text: 'first' }],
    });
    expect(a).toEqual({ inserted: 1, turnDone: false });
    expect(b).toEqual({ inserted: 1, turnDone: false }); // same seq 0, different turn id → NOT a collision
    expect(dup).toEqual({ inserted: 0, turnDone: false }); // same turn id → idempotent dedup
    const rows = await messages();
    expect(rows.map((r) => r.content).sort()).toEqual(['first', 'second']);
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

  it('persists a search_performed trace verbatim, and drops one missing query or resultText', async () => {
    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'search_performed', query: 'login loop', resultText: 'Found 1 existing ticket(s): Login loop' },
        { seq: 1, kind: 'search_performed', query: 'no result text' }, // missing resultText → dropped
        { seq: 2, kind: 'search_performed', resultText: 'no query' }, // missing query → dropped
      ],
    });
    expect(res.inserted).toBe(1);
    const rows = await messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ kind: 'search_performed', query: 'login loop', resultText: 'Found 1 existing ticket(s): Login loop' });
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

  it('does NOT close a created conversation whose post-create turn proposes ANOTHER ticket (multi-ticket intake)', async () => {
    // Live repro 2026-07-01 (project tank_MylBVnEy5UfPeQI4, ticket #929791A0):
    // the visitor asked the agent to file TWO tickets. createTicketFromChat
    // files ticket #1, sets createdTaskId, and dispatches a post-create turn.
    // That turn — instead of a plain wrap-up — proposes ticket #2. The
    // close-on-turn_done contract must NOT fire while that fresh proposal is
    // unresolved, or the conversation closes and the visitor (and any staff who
    // opens the Live session, which reuses this conversation) is left with a
    // dead "Create Ticket" card that 404s / 409s. The conversation stays open
    // until every proposal it holds is resolved.
    await db.update(widgetChatConversations)
      .set({ createdTaskId: TASK_ID, pendingTurnId: TURN_ID })
      .where(eq(widgetChatConversations.id, CONV_ID));

    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'agent_message', text: 'First ticket filed! Now for the artillery one:' },
        { seq: 1, kind: 'proposal', title: 'Purchased artillery not installed', description: 'Gold deducted, not equipped.', toolUseId: 'tu_artillery' },
        { seq: 2, kind: 'turn_done' },
      ],
    });
    expect(res).toEqual({ inserted: 2, turnDone: true });

    // Pending slot still clears (the turn genuinely finished), but the
    // conversation stays ACTIVE so the second proposal is actionable.
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'active', pendingTurnId: null });
  });

  it('closes once the LAST outstanding proposal in a created conversation resolves', async () => {
    // Continuation of the multi-ticket flow: the second proposal is created
    // (createTicketFromChat writes proposal_resolved{created}) and its own
    // post-create turn is a plain wrap-up (no new proposal). With no unresolved
    // proposal left, the close-on-turn_done contract fires as normal.
    // Separate statements (distinct created_at) so loadAllMessages orders the
    // resolve strictly AFTER the proposal — mirrors production, where each row
    // is its own insert (never a same-timestamp batch).
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'event', turnId: 'earlier', seq: 0,
      payload: { kind: 'proposal', title: 'Artillery', description: 'x', toolUseId: 'tu_artillery' },
    });
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'event', turnId: null, seq: null,
      payload: { kind: 'proposal_resolved', created: true, ticketId: TASK_ID },
    });
    await db.update(widgetChatConversations)
      .set({ createdTaskId: TASK_ID, pendingTurnId: TURN_ID })
      .where(eq(widgetChatConversations.id, CONV_ID));

    const res = await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: TURN_ID,
      events: [
        { seq: 0, kind: 'agent_message', text: 'Both tickets filed — handing off now.' },
        { seq: 1, kind: 'turn_done' },
      ],
    });
    expect(res).toEqual({ inserted: 1, turnDone: true });

    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv).toMatchObject({ status: 'closed', pendingTurnId: null });
  });
});
