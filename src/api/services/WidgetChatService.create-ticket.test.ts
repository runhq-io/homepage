/**
 * Chat-ticket creation: goes through the existing WidgetService.createTicket
 * path, but born READY — a widget_clarifications row with status='skipped' is
 * written so the detail UI shows no clarifying state (getTicketClarification
 * already de-prioritizes 'skipped' rows). The conversation stays ACTIVE until
 * the post-creation turn's turn_done (the agent gets the tool result and may
 * assign), and the post-creation dispatch carries the {created:true,ticketId}
 * resolution for the proposal's toolUseId.
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
const SERVER_ID = `ws_chatcreate_${RUN_HEX}`;
const USER_ID = `00000000-000b-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `cr+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatCreate ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_chatcreate_${RUN_HEX}`,
    name: `ChatCreate ${RUN_HEX}`,
    slug: `chatcreate-${RUN_HEX}`,
    apiKey: `apikey-cr-${RUN_HEX}`,
    apiSecretHash: `secret-cr-${RUN_HEX}`,
    channelId: `ch_cr_${RUN_HEX}`,
    widgetChatAgentEntityId: 'ae_support',
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-cr-${RUN_HEX}`, name: 'Create User',
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
  vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({ ok: true } as any);
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, userTurnCount: 3,
  }).returning();
  CONV_ID = conv!.id;
});

async function seedProposal(toolUseId = 'tu_create') {
  const [row] = await db.insert(widgetChatMessages).values({
    conversationId: CONV_ID, role: 'event',
    payload: { kind: 'proposal', title: 'Draft title', description: 'Draft description', toolUseId },
  }).returning();
  return row!;
}

describe('createTicketFromChat', () => {
  it('409s with no_pending_proposal when no proposal exists', async () => {
    await expect(WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'T', description: 'D',
    })).rejects.toMatchObject({ code: 'no_pending_proposal', status: 409 });
  });

  it('creates the ticket born-ready, links it, resolves the proposal, and dispatches the result turn', async () => {
    await seedProposal();
    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'Edited title', description: 'Edited description',
    });

    // Ticket created through the existing widget create path
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, ticketId));
    expect(task).toMatchObject({
      serverId: SERVER_ID,
      title: 'Edited title',
      description: 'Edited description',
      sourceType: 'widget',
      createdById: WIDGET_USER_ID,
    });

    // Clarifier suppressed: 'skipped' clarification row (detail UI shows no clarifying state)
    const [clar] = await db.select().from(widgetClarifications).where(eq(widgetClarifications.taskId, ticketId));
    expect(clar).toMatchObject({ status: 'skipped', widgetUserId: WIDGET_USER_ID, serverId: SERVER_ID });

    // Conversation linked but still ACTIVE (closes on the post-creation turn_done)
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.createdTaskId).toBe(ticketId);
    expect(conv!.status).toBe('active');
    expect(conv!.pendingTurnId).toBeTruthy();

    // proposal_resolved event appended
    const resolved = await db.select().from(widgetChatMessages).where(and(
      eq(widgetChatMessages.conversationId, CONV_ID),
      sql`${widgetChatMessages.payload}->>'kind' = 'proposal_resolved'`,
    ));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toEqual({ kind: 'proposal_resolved', created: true, ticketId });

    // The dispatched turn carries the synthesized tool_result resolution
    const [, , body] = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]!;
    expect((body as any).pendingProposal).toEqual({
      toolUseId: 'tu_create',
      resolution: { created: true, ticketId },
    });

    // turn_done on that turn closes the conversation
    await WidgetChatService.ingestTurnEvents(SERVER_ID, {
      conversationId: CONV_ID, turnId: (body as any).turnId,
      events: [{ seq: 0, kind: 'turn_done' }],
    });
    const [closed] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(closed!.status).toBe('closed');
  });

  it('files the ticket publicly by default', async () => {
    await seedProposal('tu_public');
    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'Public ticket', description: 'Visible to everyone',
    });
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, ticketId));
    expect(task!.visibility).toBe('public');
  });

  it('files the ticket privately when isPrivate is set', async () => {
    await seedProposal('tu_private');
    const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'Private ticket', description: 'Only the reporter sees this', isPrivate: true,
    });
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, ticketId));
    expect(task!.visibility).toBe('private');
  });

  it('validates the edited draft', async () => {
    await seedProposal();
    await expect(WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: '   ', description: 'D',
    })).rejects.toMatchObject({ code: 'invalid_proposal_draft', status: 400 });
    await expect(WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'x'.repeat(301), description: 'D',
    })).rejects.toMatchObject({ code: 'invalid_proposal_draft' });
    await expect(WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
      title: 'T', description: 'x'.repeat(10001),
    })).rejects.toMatchObject({ code: 'invalid_proposal_draft' });
  });
});

describe('dismissProposal', () => {
  it('appends proposal_resolved {created:false} and dispatches with {dismissed:true}', async () => {
    await seedProposal('tu_dismiss');
    await WidgetChatService.dismissProposal(CONV_ID, PROJECT_ID, WIDGET_USER_ID);

    const resolved = await db.select().from(widgetChatMessages).where(and(
      eq(widgetChatMessages.conversationId, CONV_ID),
      sql`${widgetChatMessages.payload}->>'kind' = 'proposal_resolved'`,
    ));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toEqual({ kind: 'proposal_resolved', created: false });

    const [, , body] = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]!;
    expect((body as any).pendingProposal).toEqual({
      toolUseId: 'tu_dismiss',
      resolution: { dismissed: true },
    });

    // No ticket, so the conversation stays active and usable
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.status).toBe('active');
    expect(conv!.createdTaskId).toBeNull();
  });

  it('409s without a pending proposal', async () => {
    await expect(WidgetChatService.dismissProposal(CONV_ID, PROJECT_ID, WIDGET_USER_ID))
      .rejects.toMatchObject({ code: 'no_pending_proposal' });
  });
});

describe('createTicketFromChat auto-assign hook', () => {
  it('fires the server-side auto-assign hook with the new ticket id', async () => {
    const spy = vi.fn();
    const restore = WidgetChatService.__setAutoAssignForTests(spy);
    try {
      await seedProposal('tu_autoassign');
      const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
        title: 'Hook title', description: 'Hook description',
      });
      expect(spy).toHaveBeenCalledWith(PROJECT_ID, ticketId, WIDGET_USER_ID, { creatorCanAssign: true });
    } finally {
      restore();
    }
  });

  it('passes creatorCanAssign through to the auto-assign hook (unauthorized reporter)', async () => {
    const spy = vi.fn();
    const restore = WidgetChatService.__setAutoAssignForTests(spy);
    try {
      await seedProposal('tu_autoassign_unauth');
      const { ticketId } = await WidgetChatService.createTicketFromChat(CONV_ID, PROJECT_ID, WIDGET_USER_ID, {
        title: 'Hook title', description: 'Hook description',
      }, false);
      expect(spy).toHaveBeenCalledWith(PROJECT_ID, ticketId, WIDGET_USER_ID, { creatorCanAssign: false });
    } finally {
      restore();
    }
  });
});
