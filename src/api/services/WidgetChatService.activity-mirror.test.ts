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
  workspaceTaskActivity,
  widgetChatConversations,
  widgetChatMessages,
} from '../../db/schema';
import * as WidgetChatService from './WidgetChatService';
import * as WidgetService from './WidgetService';

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
  await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, TASK_ID));
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

// Stamp a fresh activity id per insert so the `act:<id>` turn id is unique.
let actSeq = 0;
function actId(): string { return `${RUN_HEX}-act-${actSeq++}`; }

async function clearEvents() {
  await db.delete(widgetChatMessages).where(eq(widgetChatMessages.conversationId, CONV_ID));
}

describe('mirrorActivityToLiveSession', () => {
  it('mirrors a status change into the live session as an activity event row + publishes it', async () => {
    await clearEvents();
    const seen: Array<{ role: string; payload: unknown }> = [];
    const unsub = WidgetChatService.subscribeToConversation(CONV_ID, (row) =>
      seen.push({ role: row.role, payload: row.payload }));
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, {
      id: actId(), type: 'status_change', content: null, metadata: { from: 'in_progress', to: 'needs_review' },
    });
    unsub();
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('event');
    expect(rows[0]!.payload).toMatchObject({
      kind: 'activity', activityType: 'status_change', metadata: { from: 'in_progress', to: 'needs_review' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe('event');
  });

  it('mirrors milestones (agent_update), PR lifecycle (pr_linked), and assignment', async () => {
    await clearEvents();
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type: 'agent_update', content: 'Deploying now.', metadata: null });
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type: 'pr_linked', content: null, metadata: { state: 'merged' } });
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type: 'agent_assigned', content: null, metadata: { agentName: 'Codey' } });
    const kinds = (await eventRows())
      .map((r) => (r.payload as { activityType?: string } | null)?.activityType)
      .sort();
    expect(kinds).toEqual(['agent_assigned', 'agent_update', 'pr_linked']);
  });

  it('does NOT mirror comments/edits/archive (kept off the live session)', async () => {
    await clearEvents();
    for (const type of ['comment_added', 'comment', 'ticket_edited', 'task_archived', 'attachment_added']) {
      await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type, content: 'x', metadata: null });
    }
    expect(await eventRows()).toHaveLength(0);
  });

  it('skips assignment activity when the thread already has the chat `assigned` event (dedup)', async () => {
    await clearEvents();
    // The chat-native assignment representation already in the thread.
    await db.insert(widgetChatMessages).values({
      conversationId: CONV_ID, role: 'event', content: '',
      payload: { kind: 'assigned', ticketId: TASK_ID, agentEntityId: 'ae_x', agentName: 'Codey' },
    });
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type: 'agent_assigned', content: null, metadata: { agentName: 'Codey' } });
    // Only the original `assigned` event — no duplicate activity line.
    const kinds = (await eventRows()).map((r) => (r.payload as { kind?: string } | null)?.kind);
    expect(kinds).toEqual(['assigned']);
    // A status change still mirrors (dedup is assignment-only).
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: actId(), type: 'status_change', content: null, metadata: { to: 'done' } });
    expect(await eventRows()).toHaveLength(2);
  });

  it('is idempotent: the same activity id never produces a duplicate line', async () => {
    await clearEvents();
    const id = actId();
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id, type: 'status_change', content: null, metadata: { to: 'done' } });
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id, type: 'status_change', content: null, metadata: { to: 'done' } });
    expect(await eventRows()).toHaveLength(1);
  });

  it('is a no-op when no conversation is linked to the task', async () => {
    await clearEvents();
    const [orphan] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'No session', sourceType: 'widget', createdByType: 'external', visibility: 'public',
    }).returning({ id: workspaceTasks.id });
    await WidgetChatService.mirrorActivityToLiveSession(orphan!.id, { id: actId(), type: 'status_change', content: null, metadata: { to: 'done' } });
    expect(await eventRows()).toHaveLength(0);
  });
});

describe('backfillLiveSessionActivity', () => {
  it('replays the ticket\'s allowlisted activity into a freshly-opened session, skipping comments', async () => {
    await clearEvents();
    await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, TASK_ID));
    // Seed a realistic pre-session timeline (what the screenshot showed + noise).
    await db.insert(workspaceTaskActivity).values([
      { serverId: SERVER_ID, taskId: TASK_ID, type: 'agent_assigned', content: null, metadata: { agentName: 'Codey' }, createdByType: 'external', createdByName: 'p2' },
      { serverId: SERVER_ID, taskId: TASK_ID, type: 'comment', content: 'Coder session started', createdByType: 'agent' },
      { serverId: SERVER_ID, taskId: TASK_ID, type: 'status_change', content: null, metadata: { from: 'pending', to: 'in_progress' }, createdByType: 'agent' },
      { serverId: SERVER_ID, taskId: TASK_ID, type: 'comment_added', content: 'a public comment', createdByType: 'external' },
    ]);
    await WidgetChatService.backfillLiveSessionActivity(CONV_ID, TASK_ID);
    const kinds = (await eventRows())
      .map((r) => (r.payload as { activityType?: string } | null)?.activityType)
      .sort();
    // assignment + status backfilled; the comment/coder-session markers are NOT.
    expect(kinds).toEqual(['agent_assigned', 'status_change']);
  });

  it('resolves the task from the conversation (backfillLiveSessionForConversation)', async () => {
    await clearEvents();
    await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, TASK_ID));
    await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID, taskId: TASK_ID, type: 'pr_linked', content: null, metadata: { state: 'merged' }, createdByType: 'agent',
    });
    await WidgetChatService.backfillLiveSessionForConversation(CONV_ID);
    expect(await eventRows()).toHaveLength(1);
  });

  it('is a no-op for an intake conversation with no linked ticket', async () => {
    const [intake] = await db.insert(widgetChatConversations).values({
      widgetProjectId: PROJECT_ID, widgetUserId: WIDGET_USER_ID,
    }).returning({ id: widgetChatConversations.id });
    await WidgetChatService.backfillLiveSessionForConversation(intake!.id);
    const rows = await db.select().from(widgetChatMessages).where(eq(widgetChatMessages.conversationId, intake!.id));
    expect(rows).toHaveLength(0);
    await db.delete(widgetChatConversations).where(eq(widgetChatConversations.id, intake!.id));
  });

  it('is idempotent with the forward mirror and across re-opens (shared act:<id> turn id)', async () => {
    await clearEvents();
    await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, TASK_ID));
    const [act] = await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID, taskId: TASK_ID, type: 'status_change', content: null, metadata: { to: 'done' }, createdByType: 'agent',
    }).returning({ id: workspaceTaskActivity.id });
    // Forward-mirror it live, then backfill the same activity twice on re-open.
    await WidgetChatService.mirrorActivityToLiveSession(TASK_ID, { id: act!.id, type: 'status_change', content: null, metadata: { to: 'done' } });
    await WidgetChatService.backfillLiveSessionActivity(CONV_ID, TASK_ID);
    await WidgetChatService.backfillLiveSessionActivity(CONV_ID, TASK_ID);
    expect(await eventRows()).toHaveLength(1);
  });
});

describe('deploy-environment sync (env id→name for deployed:<envId> labels)', () => {
  const WSP = `wsp_actmirror_${RUN_HEX}`;

  it('stores the env map on the widget project and surfaces it in the bootstrap', async () => {
    await WidgetService.syncDeployEnvironments(SERVER_ID, {
      [WSP]: [{ id: 'denv_ec106c0a7c6b4644', name: 'Production' }, { id: 'denv_stg', name: 'Staging' }],
    });
    const [row] = await db
      .select({ envs: widgetProjects.deployEnvironments })
      .from(widgetProjects)
      .where(eq(widgetProjects.id, PROJECT_ID));
    expect(row!.envs).toEqual([
      { id: 'denv_ec106c0a7c6b4644', name: 'Production' },
      { id: 'denv_stg', name: 'Staging' },
    ]);
    // The widget bootstrap carries it so the client can resolve labels.
    const bootstrap = await WidgetService.listTickets(PROJECT_ID);
    expect(bootstrap.environments).toEqual([
      { id: 'denv_ec106c0a7c6b4644', name: 'Production' },
      { id: 'denv_stg', name: 'Staging' },
    ]);
  });

  it('skips malformed entries and never throws on bad shapes', async () => {
    await WidgetService.syncDeployEnvironments(SERVER_ID, {
      [WSP]: [{ id: 'denv_ok', name: 'Prod' }, { id: 123 }, null, { name: 'no-id' }] as unknown[],
      '': [{ id: 'x', name: 'y' }], // empty project id ignored
    } as Record<string, unknown>);
    const [row] = await db
      .select({ envs: widgetProjects.deployEnvironments })
      .from(widgetProjects)
      .where(eq(widgetProjects.id, PROJECT_ID));
    expect(row!.envs).toEqual([{ id: 'denv_ok', name: 'Prod' }]);
  });
});
