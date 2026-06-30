/**
 * listTicketsAssignedByMe: a live-session reply (coder agent_message / teammate
 * team_message) must light the assigner's widget unread. The assigner is the
 * author of the latest agent_assigned activity (createdById = their
 * externalUserId). Their OWN live message (role='user') is not unread for them.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users, servers, workspaceTasks, workspaceTaskActivity,
  widgetProjects, widgetUsers, widgetChatConversations,
} from '../../db/schema';
import { listTicketsAssignedByMe } from './WidgetService';
import * as WidgetChatService from './WidgetChatService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_asn_${RUN_HEX}`;
const USER_ID = `00000000-000a-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;
let ASSIGNER_WUID: string;          // the assigner's widget user id
const ASSIGNER_EXT = `runhq:assigner-${RUN_HEX}`;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `ASN ${RUN_HEX}`, slug: `asn-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: ASSIGNER_EXT, name: 'Assigner',
  }).returning({ id: widgetUsers.id });
  ASSIGNER_WUID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeAssignedTask(title: string, assignerExt: string, status = 'in_progress') {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title,
    visibility: 'public', status,
    sourceType: 'widget', createdByType: 'external', createdById: ASSIGNER_WUID,
  }).returning({ id: workspaceTasks.id });
  await db.insert(workspaceTaskActivity).values({
    serverId: SERVER_ID, taskId: task!.id, type: 'agent_assigned',
    metadata: { agentName: 'Coder' },
    createdByType: 'external', createdById: assignerExt, createdByName: 'Assigner',
  });
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: ASSIGNER_WUID,
    status: 'active', createdTaskId: task!.id,
  }).returning({ id: widgetChatConversations.id });
  return { taskId: task!.id, convId: conv!.id };
}

describe('listTicketsAssignedByMe', () => {
  it('returns tickets I assigned and excludes ones assigned by someone else', async () => {
    const mine = await makeAssignedTask('Mine', ASSIGNER_EXT);
    const other = await makeAssignedTask('Other', `runhq:someone-else-${RUN_HEX}`);
    try {
      const rows = await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(mine.taskId);
      expect(ids).not.toContain(other.taskId);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, mine.taskId));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, other.taskId));
    }
  });

  it('lastActivityAt advances on a coder reply but not on the assigner\'s own message', async () => {
    const { taskId, convId } = await makeAssignedTask('Activity', ASSIGNER_EXT);
    try {
      const base = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();

      // assigner's own live message → role='user' → must NOT bump
      await new Promise((r) => setTimeout(r, 10));
      await WidgetChatService.sendLiveCoderMessage(convId, PROJECT_ID, 'Any update?');
      const afterOwn = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();
      expect(afterOwn).toBe(base);

      // coder reply → role='agent' → must bump
      await new Promise((r) => setTimeout(r, 10));
      await WidgetChatService.ingestTurnEvents(SERVER_ID, {
        conversationId: convId, turnId: `turn-${RUN_HEX}`,
        events: [{ kind: 'agent_message', seq: 0, text: 'Pushed a fix.' }],
      });
      const afterReply = new Date(
        (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).find((r) => r.id === taskId)!.lastActivityAt!,
      ).getTime();
      expect(afterReply).toBeGreaterThan(base);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId));
    }
  });

  it('excludes terminal (deployed) tickets', async () => {
    const { taskId } = await makeAssignedTask('Done', ASSIGNER_EXT, 'deployed');
    try {
      const ids = (await listTicketsAssignedByMe(PROJECT_ID, ASSIGNER_WUID)).map((r) => r.id);
      expect(ids).not.toContain(taskId);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId));
    }
  });
});
