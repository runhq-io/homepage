/**
 * Agentless [Submit Ticket]: the BE derives the draft server-side from the
 * STORED user messages (title = first message word-boundary-trimmed to ~80
 * chars; description = all user messages joined chronologically), creates the
 * ticket through the same born-ready path createTicketFromChat uses
 * (clarifier 'skipped'), appends proposal_resolved {created:true, ticketId},
 * and CLOSES the conversation (no post-create turn — there is no agent).
 * 409s with distinct codes for agent-driven / closed / already-ticketed /
 * empty conversations. Runs against the scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  widgetClarifications,
  workspaceTasks,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';
import * as ServerService from './ServerService';

vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn(),
}));

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatsubmit_${RUN_HEX}`;
const USER_ID = `00000000-000f-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string; // agentless
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `st+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatSubmit ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatsubmit_${RUN_HEX}`,
    name: `ChatSubmit ${RUN_HEX}`,
    slug: `chatsubmit-${RUN_HEX}`,
    apiKey: `apikey-st-${RUN_HEX}`,
    apiSecretHash: `secret-st-${RUN_HEX}`,
    channelId: `ch_st_${RUN_HEX}`,
    // agentless — widgetChatAgentEntityId NULL
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-st-${RUN_HEX}`, name: 'Submit User',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetClarifications).where(eq(widgetClarifications.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

let CONV_ID: string;

beforeEach(async () => {
  vi.mocked(ServerService.serverTokenFetch).mockReset();
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID,
  }).returning();
  CONV_ID = conv!.id;
});

async function seedUserMessage(content: string) {
  const [row] = await db.insert(widgetChatMessages).values({
    conversationId: CONV_ID, role: 'user', content,
  }).returning();
  return row!;
}

describe('deriveTicketDraft', () => {
  it('uses a short first message verbatim as the title', () => {
    expect(WidgetChatService.deriveTicketDraft(['Login button broken'])).toEqual({
      title: 'Login button broken',
      description: 'Login button broken',
    });
  });

  it('trims long first messages to ~80 chars at a word boundary with an ellipsis', () => {
    const first =
      'The dashboard takes more than thirty seconds to load every time I open it from the mobile app and sometimes it just times out';
    const { title } = WidgetChatService.deriveTicketDraft([first]);
    expect(title.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(title.endsWith('…')).toBe(true);
    // Word boundary: no mid-word cut before the ellipsis.
    const stem = title.slice(0, -1);
    expect(first.startsWith(stem + ' ') || first === stem).toBe(true);
  });

  it('normalizes title whitespace (multiline first messages become one line)', () => {
    const { title } = WidgetChatService.deriveTicketDraft(['Crash report:\n\napp dies   on launch']);
    expect(title).toBe('Crash report: app dies on launch');
  });

  it('joins all user messages chronologically, blank-line separated', () => {
    const { description } = WidgetChatService.deriveTicketDraft(['First part', 'Second part', 'Third part']);
    expect(description).toBe('First part\n\nSecond part\n\nThird part');
  });
});

describe('submitTicketFromConversation', () => {
  it('creates a born-ready ticket from the stored messages, resolves, and closes', async () => {
    await seedUserMessage('Checkout fails with a 500 on the payment step');
    await seedUserMessage('It happens on both Chrome and Safari, started yesterday');

    const seen: WidgetChatService.ChatMessageRow[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(CONV_ID, (row) => seen.push(row));
    let ticketId: string;
    try {
      ({ ticketId } = await WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID));
    } finally {
      unsubscribe();
    }

    // Ticket: derived title + chronologically joined description.
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, ticketId));
    expect(task).toBeDefined();
    expect(task!.title).toBe('Checkout fails with a 500 on the payment step');
    expect(task!.description).toBe(
      'Checkout fails with a 500 on the payment step\n\nIt happens on both Chrome and Safari, started yesterday',
    );

    // Born ready: clarifier 'skipped' row written.
    const [clar] = await db.select().from(widgetClarifications)
      .where(and(eq(widgetClarifications.taskId, ticketId), eq(widgetClarifications.status, 'skipped')));
    expect(clar).toBeDefined();
    expect(clar!.command).toBe('widget_chat');

    // proposal_resolved {created:true, ticketId} appended + published.
    const [resolved] = await db.select().from(widgetChatMessages).where(and(
      eq(widgetChatMessages.conversationId, CONV_ID),
      sql`${widgetChatMessages.payload}->>'kind' = 'proposal_resolved'`,
    ));
    expect(resolved!.payload).toEqual({ kind: 'proposal_resolved', created: true, ticketId });
    expect(seen.some((r) => r.payload?.kind === 'proposal_resolved')).toBe(true);

    // Conversation linked + closed; no turn ever dispatched.
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.createdTaskId).toBe(ticketId);
    expect(conv!.status).toBe('closed');
    expect(ServerService.serverTokenFetch).not.toHaveBeenCalled();
  });

  it('409s no_user_messages when the conversation has no user messages', async () => {
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'no_user_messages', status: 409 });
  });

  it('409s agent_turns_present when any agent turn touched the conversation', async () => {
    await seedUserMessage('Hello');
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'agent', content: 'Hi, how can I help?',
      turnId: randomUUID(), seq: 0,
    });
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'agent_turns_present', status: 409 });
  });

  it('409s agent_turns_present when a turn is pending (dispatched, not yet reported)', async () => {
    await seedUserMessage('Hello');
    await db.update(widgetChatConversations)
      .set({ pendingTurnId: randomUUID() })
      .where(eq(widgetChatConversations.id, CONV_ID));
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'agent_turns_present', status: 409 });
  });

  it('409s ticket_already_created when the conversation already produced a ticket', async () => {
    await seedUserMessage('Hello');
    await db.update(widgetChatConversations)
      .set({ createdTaskId: randomUUID() })
      .where(eq(widgetChatConversations.id, CONV_ID));
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'ticket_already_created', status: 409 });
  });

  it('409s conversation_closed on closed conversations', async () => {
    await seedUserMessage('Hello');
    await db.update(widgetChatConversations)
      .set({ status: 'closed' })
      .where(eq(widgetChatConversations.id, CONV_ID));
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'conversation_closed', status: 409 });
  });

  it('stays owner-scoped (conversation_not_found for strangers)', async () => {
    await seedUserMessage('Hello');
    const [stranger] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-stranger-${RUN_HEX}`, name: 'Stranger',
    }).returning({ id: widgetUsers.id });
    await expect(WidgetChatService.submitTicketFromConversation(CONV_ID, PROJECT_ID, stranger!.id))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
  });
});
