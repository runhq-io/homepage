/**
 * mirrorActivityToLiveSession: progress-bearing ticket activity (status change,
 * milestone, PR lifecycle) is mirrored into the ticket's live-session chat
 * thread as a role='event' row, so the session shows the same timeline as the
 * public ticket screen. Excludes non-progress activity and is a no-op when no
 * conversation is linked to the task. Runs against the scratch Postgres.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  workspaceTasks,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_actmirror_${RUN_HEX}`;
const USER_ID = `00000000-00fa-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;
let TASK_ID: string;
let CONV_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `ci+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `ActMirror ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    workspaceProjectId: `wsp_actmirror_${RUN_HEX}`,
    name: `ActMirror ${RUN_HEX}`,
    slug: `actmirror-${RUN_HEX}`,
    apiKey: `apikey-am-${RUN_HEX}`,
    apiSecretHash: `secret-am-${RUN_HEX}`,
    channelId: `ch_am_${RUN_HEX}`,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-am-${RUN_HEX}`, name: 'Reporter',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Linked task', sourceType: 'widget', createdByType: 'external', visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;
  const [conv] = await db.insert(widgetChatConversations).values({
    widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID, createdTaskId: TASK_ID,
  }).returning({ id: widgetChatConversations.id });
  CONV_ID = conv!.id;
});

afterAll(async () => {
  await db.delete(widgetChatMessages).where(eq(widgetChatMessages.conversationId, CONV_ID));
  await db.delete(widgetChatConversations).where(eq(widgetChatConversations.id, CONV_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.id, WIDGET_USER_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function eventRows() {
  return db
    .select()
    .from(widgetChatMessages)
    .where(eq(widgetChatMessages.conversationId, CONV_ID));
}

describe('mirrorActivityToLiveSession', () => {
  it('mirrors a status change into the live session as an activity event row + publishes it', async () => {
    const seen: Array<{ role: string; payload: unknown }> = [];
    const unsub = WidgetChatService.subscribeToConversation(CONV_ID, (row) =>
      seen.push({ role: row.role, payload: row.payload }));
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, {
      type: 'status_change', content: null, metadata: { from: 'in_progress', to: 'needs_review' },
    });
    unsub();
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('event');
    expect(rows[0]!.payload).toMatchObject({
      kind: 'activity', activityType: 'status_change', metadata: { from: 'in_progress', to: 'needs_review' },
    });
    // Delivered live over SSE too.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe('event');
  });

  it('mirrors milestones (agent_update) and PR lifecycle (pr_linked)', async () => {
    await db.delete(widgetChatMessages).where(eq(widgetChatMessages.conversationId, CONV_ID));
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, {
      type: 'agent_update', content: 'Deploying now.', metadata: null,
    });
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, {
      type: 'pr_linked', content: null, metadata: { state: 'merged' },
    });
    const kinds = (await eventRows())
      .map((r) => (r.payload as { activityType?: string } | null)?.activityType)
      .sort();
    expect(kinds).toEqual(['agent_update', 'pr_linked']);
  });

  it('does NOT mirror non-progress activity (comments, edits, assignment)', async () => {
    await db.delete(widgetChatMessages).where(eq(widgetChatMessages.conversationId, CONV_ID));
    for (const type of ['comment_added', 'ticket_edited', 'agent_assigned', 'task_archived']) {
      await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { type, content: 'x', metadata: null });
    }
    expect(await eventRows()).toHaveLength(0);
  });

  it('is a no-op when no conversation is linked to the task', async () => {
    const [orphan] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'No session', sourceType: 'widget', createdByType: 'external', visibility: 'public',
    }).returning({ id: workspaceTasks.id });
    // Must not throw, and must not touch the existing conversation.
    await db.delete(widgetChatMessages).where(eq(widgetChatMessages.conversationId, CONV_ID));
    await WidgetChatService.mirrorActivityToLiveSession(orphan!.id, {
      type: 'status_change', content: null, metadata: { to: 'done' },
    });
    expect(await eventRows()).toHaveLength(0);
  });
});
