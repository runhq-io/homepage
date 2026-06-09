/**
 * User-message turns + BE→workspace dispatch. serverTokenFetch is mocked
 * (transport is HMAC-signed in ServerService); everything else runs against
 * the scratch Postgres. Covers the 4000-char cap, the 30-turn cap,
 * closed/foreign conversations, the turn-body contract, the
 * workspace-offline notice, the turn timeout (window shrunk via
 * WIDGET_CHAT_TURN_TIMEOUT_MS), pub/sub, and force-proposal.
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
const SERVER_ID = `ws_chatturn_${RUN_HEX}`;
const USER_ID = `00000000-000e-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const WSP_ID = `wsp_chatturn_${RUN_HEX}`;
let PROJECT_ID: string;
let OWNER_ID: string;
let STRANGER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `ct+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatTurn ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: WSP_ID,
    name: `ChatTurn ${RUN_HEX}`,
    slug: `chatturn-${RUN_HEX}`,
    apiKey: `apikey-ct-${RUN_HEX}`,
    apiSecretHash: `secret-ct-${RUN_HEX}`,
    channelId: `ch_ct_${RUN_HEX}`,
    widgetChatAgentEntityId: 'ae_support',
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
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
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

let CONV_ID: string;

beforeEach(async () => {
  vi.mocked(ServerService.serverTokenFetch).mockReset();
  vi.mocked(ServerService.serverTokenFetch).mockResolvedValue({ ok: true } as any);
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.widgetProjectId, PROJECT_ID));
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: OWNER_ID,
  }).returning();
  CONV_ID = conv!.id;
});

const unavailableNotices = () => db.select().from(widgetChatMessages).where(and(
  eq(widgetChatMessages.conversationId, CONV_ID),
  sql`${widgetChatMessages.payload}->>'code' = 'agent_unavailable'`,
));

describe('sendUserMessage', () => {
  it('appends the row, bumps user_turn_count, and dispatches the turn-body contract', async () => {
    const msg = await WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, '  My exports are broken  ');
    expect(msg).toMatchObject({ conversationId: CONV_ID, role: 'user', content: 'My exports are broken' });

    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.userTurnCount).toBe(1);
    expect(conv!.pendingTurnId).toBeTruthy();

    expect(ServerService.serverTokenFetch).toHaveBeenCalledTimes(1);
    const [server, path, body] = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]!;
    expect((server as any).id).toBe(SERVER_ID);
    expect(path).toBe('/api/internal/widget-chat/turn');
    expect(body).toMatchObject({
      conversationId: CONV_ID,
      turnId: conv!.pendingTurnId,
      serverId: SERVER_ID,
      projectId: WSP_ID,
      agentEntityId: 'ae_support',
      chatInstructions: null,
      forceProposal: false,
      pendingProposal: null,
    });
    expect((body as any).transcript).toEqual([{ role: 'user', content: 'My exports are broken' }]);
  });

  it('rejects empty and over-long messages without dispatching', async () => {
    await expect(WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, '   '))
      .rejects.toMatchObject({ code: 'message_required', status: 400 });
    await expect(WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'x'.repeat(4001)))
      .rejects.toMatchObject({ code: 'message_too_long', status: 400 });
    expect(ServerService.serverTokenFetch).not.toHaveBeenCalled();
  });

  it('409s turn_limit_reached at the 30-user-turn cap', async () => {
    await db.update(widgetChatConversations).set({ userTurnCount: 30 })
      .where(eq(widgetChatConversations.id, CONV_ID));
    await expect(WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'one more'))
      .rejects.toMatchObject({ code: 'turn_limit_reached', status: 409 });
  });

  it('rejects foreign and closed conversations', async () => {
    await expect(WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, STRANGER_ID, 'hi'))
      .rejects.toMatchObject({ code: 'conversation_not_found', status: 404 });
    await db.update(widgetChatConversations).set({ status: 'closed' })
      .where(eq(widgetChatConversations.id, CONV_ID));
    await expect(WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'hi'))
      .rejects.toMatchObject({ code: 'conversation_closed', status: 409 });
  });

  it('carries an unresolved proposal as {noAction:true} so the workspace can synthesize the tool_result', async () => {
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'event',
      payload: { kind: 'proposal', title: 'T', description: 'D', toolUseId: 'tu_pending' },
    });
    await WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'actually one more thing');
    const [, , body] = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]!;
    expect((body as any).pendingProposal).toEqual({ toolUseId: 'tu_pending', resolution: { noAction: true } });
  });

  it('publishes appended rows to conversation subscribers', async () => {
    const seen: string[] = [];
    const unsubscribe = WidgetChatService.subscribeToConversation(CONV_ID, (row) => seen.push(row.content));
    await WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'hello there');
    unsubscribe();
    expect(seen).toEqual(['hello there']);
  });

  it('writes an agent_unavailable notice and clears the pending turn when the workspace is unreachable', async () => {
    vi.mocked(ServerService.serverTokenFetch).mockRejectedValue(new Error('ECONNREFUSED'));
    await WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'anyone home?');
    const notices = await unavailableNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.turnId).toBeTruthy(); // late turn_done can find + delete it
    expect(notices[0]!.seq).toBeNull();
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.pendingTurnId).toBeNull();
  });

  it('times out a silent turn into the same notice (window shrunk via env)', async () => {
    process.env.WIDGET_CHAT_TURN_TIMEOUT_MS = '50';
    try {
      await WidgetChatService.sendUserMessage(CONV_ID, PROJECT_ID, OWNER_ID, 'slow agent');
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      delete process.env.WIDGET_CHAT_TURN_TIMEOUT_MS;
    }
    const notices = await unavailableNotices();
    expect(notices).toHaveLength(1);
    const [conv] = await db.select().from(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
    expect(conv!.pendingTurnId).toBeNull();
  });
});

describe('forceProposal', () => {
  it('appends the force_proposal_requested marker and dispatches with forceProposal=true', async () => {
    await WidgetChatService.forceProposal(CONV_ID, PROJECT_ID, OWNER_ID);
    const markers = await db.select().from(widgetChatMessages).where(and(
      eq(widgetChatMessages.conversationId, CONV_ID),
      sql`${widgetChatMessages.payload}->>'kind' = 'force_proposal_requested'`,
    ));
    expect(markers).toHaveLength(1);
    const [, , body] = vi.mocked(ServerService.serverTokenFetch).mock.calls[0]!;
    expect((body as any).forceProposal).toBe(true);
    expect((body as any).transcript).toEqual([
      { role: 'event', payload: { kind: 'force_proposal_requested' } },
    ]);
  });
});
