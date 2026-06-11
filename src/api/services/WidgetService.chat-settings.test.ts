/**
 * Chat settings persistence (widget_chat_agent_entity_id +
 * widget_chat_instructions) through get/updateWidgetSettings, and the
 * widget bootstrap `chat: { enabled, agentName }` field on listTickets
 * (agentName resolved from the widget_exposed_agents mirror regardless of the
 * `exposed` flag; null only when the chosen agent isn't mirrored at all).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, widgetProjects, widgetExposedAgents } from '../../db/schema';
import * as WidgetService from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_chatset_${RUN_HEX}`;
const USER_ID = `00000000-000c-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const WSP_ID = `wsp_chatset_${RUN_HEX}`;
const LOOKUP = { workspaceProjectId: WSP_ID };
let PROJECT_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `cw+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ChatSet ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: WSP_ID,
    name: `ChatSet ${RUN_HEX}`,
    slug: `chatset-${RUN_HEX}`,
    apiKey: `apikey-cw-${RUN_HEX}`,
    apiSecretHash: `secret-cw-${RUN_HEX}`,
    channelId: `ch_cw_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('chat settings round-trip', () => {
  it('persists widgetChatAgentEntityId and accept-ignores widgetChatInstructions', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetChatAgentEntityId: 'ae_support',
      // sent by a stale client — must be ignored without error
      widgetChatInstructions: 'Ask for the plan tier.',
    } as any, LOOKUP);
    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetChatAgentEntityId).toBe('ae_support');
    expect('widgetChatInstructions' in settings!).toBe(false);
  });

  it('clears with null / empty string', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, {
      widgetChatAgentEntityId: '',
    }, LOOKUP);
    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetChatAgentEntityId).toBeNull();
  });

  it('leaves chat fields untouched when not supplied', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetChatAgentEntityId: 'ae_keep' }, LOOKUP);
    await WidgetService.updateWidgetSettings(SERVER_ID, { auto_approve: true }, LOOKUP);
    const settings = await WidgetService.getWidgetSettings(SERVER_ID, LOOKUP);
    expect(settings!.widgetChatAgentEntityId).toBe('ae_keep');
  });
});

describe('bootstrap chat field on listTickets', () => {
  it('chat disabled → { enabled: false, agentName: null }', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetChatAgentEntityId: null }, LOOKUP);
    const result = await WidgetService.listTickets(PROJECT_ID);
    expect(result.chat).toEqual({ enabled: false, agentName: null });
  });

  it('enabled with the mirrored agent name', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetChatAgentEntityId: 'ae_support' }, LOOKUP);
    await db.insert(widgetExposedAgents).values({
      widgetProjectId: PROJECT_ID, agentId: 'ae_support', agentName: 'Suppy', agentDescription: null,
    }).onConflictDoNothing();
    const result = await WidgetService.listTickets(PROJECT_ID);
    expect(result.chat).toEqual({ enabled: true, agentName: 'Suppy' });
  });

  it('enabled but unmirrored agent → agentName null', async () => {
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetChatAgentEntityId: 'ae_ghost' }, LOOKUP);
    const result = await WidgetService.listTickets(PROJECT_ID);
    expect(result.chat).toEqual({ enabled: true, agentName: null });
  });

  it('resolves the name of a mirrored but NOT exposed agent (chat ⊥ assignment)', async () => {
    // The support agent is mirrored with exposed=false — i.e. NOT in the
    // "Hand to agent" roster. Its chat header name must still resolve:
    // naming the chat agent is independent of widget-user assignment.
    await WidgetService.updateWidgetSettings(SERVER_ID, { widgetChatAgentEntityId: 'ae_chat_only' }, LOOKUP);
    await db.insert(widgetExposedAgents).values({
      widgetProjectId: PROJECT_ID, agentId: 'ae_chat_only', agentName: 'Suha', agentDescription: null,
      exposed: false,
    }).onConflictDoNothing();
    const result = await WidgetService.listTickets(PROJECT_ID);
    expect(result.chat).toEqual({ enabled: true, agentName: 'Suha' });

    // ...and it must NOT appear in the assignable roster.
    const roster = await WidgetService.listExposedAgents(PROJECT_ID);
    expect(roster.find(a => a.id === 'ae_chat_only')).toBeUndefined();
  });
});
