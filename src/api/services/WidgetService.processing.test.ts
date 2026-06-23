/**
 * WidgetService.processing.test.ts — integration coverage for the `processing`
 * flag on PublicTicketDetail and the way it (and an open clarification) suppress
 * the manual `canAssign` affordance.
 *
 *  - `processing` is true while a freshly-filed ticket is still being reviewed by
 *    auto-assign: assignment enabled, NO outcome recorded on metadata.autoAssign
 *    yet, status pending, no clarification, no agent.
 *  - `canAssign` is hidden while the system is already handling assignment —
 *    during `processing`, and while a clarification card is open (asking).
 *
 * Self-contained setup (channelId set) so it runs regardless of whether the
 * scratch DB has widget_projects.channel_id nullable or NOT NULL.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects, widgetUsers, widgetClarifications } from '../../db/schema';
import { getPublicTicketDetail, type WidgetPermission } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_proc_test_${RUN_HEX}`;
const USER_ID = `00000000-000c-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-proc-${RUN_HEX}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

const ASSIGN_PERM = new Set<WidgetPermission>(['assign_agent']);
const OUTCOME = { autoAssign: { status: 'skipped_no_agent', at: '2026-06-23T00:00:00.000Z' } };

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+proc+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv Proc ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Processing Test ${RUN_HEX}`,
    slug: `processing-${RUN_HEX}`,
    apiKey: `apikey-proc-${RUN_HEX}`,
    apiSecretHash: `secret-proc-${RUN_HEX}`,
    channelId: CHANNEL_ID,
    enabled: true,
    isPublic: true,
    // Auto-assign runs for this project — a prerequisite for "processing".
    widgetAgentAssignmentEnabled: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-proc-${RUN_HEX}`, name: 'Reporter',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetClarifications).where(eq(widgetClarifications.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeTask(metadata?: Record<string, unknown>) {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    workspaceChannelId: CHANNEL_ID,
    title: 'Freshly filed ticket',
    visibility: 'public',
    status: 'pending',
    ...(metadata ? { metadata } : {}),
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

describe('getPublicTicketDetail — processing flag', () => {
  it('processing is true for a freshly-filed pending ticket with no auto-assign outcome yet', async () => {
    const id = await makeTask(); // no metadata.autoAssign → still being reviewed
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail).not.toBeNull();
      expect(detail!.processing).toBe(true);
      // ...and the manual "Assign agent" button is hidden while reviewing.
      expect(detail!.canAssign).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('processing is false once auto-assign has recorded an outcome on metadata', async () => {
    const id = await makeTask(OUTCOME);
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail!.processing).toBe(false);
      // Outcome recorded, no clarification, no agent, actionable ⇒ Assign is available again.
      expect(detail!.canAssign).toBe(true);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('processing is false when assignment is disabled (no project-level auto-assign)', async () => {
    // A separate project with assignment OFF — a pending, outcome-less ticket is
    // NOT "being reviewed" because nothing reviews it.
    const [offProject] = await db.insert(widgetProjects).values({
      serverId: SERVER_ID, name: `NoAssign ${RUN_HEX}`, slug: `noassign-${RUN_HEX}`,
      apiKey: `apikey-na-${RUN_HEX}`, apiSecretHash: `secret-na-${RUN_HEX}`,
      channelId: CHANNEL_ID, enabled: true, isPublic: true,
      widgetAgentAssignmentEnabled: false,
    }).returning({ id: widgetProjects.id });
    const id = await makeTask();
    try {
      const detail = await getPublicTicketDetail(offProject!.id, id, undefined, ASSIGN_PERM);
      expect(detail!.processing).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
      await db.delete(widgetProjects).where(eq(widgetProjects.id, offProject!.id));
    }
  });
});

describe('getPublicTicketDetail — canAssign suppressed during clarification', () => {
  it('canAssign is false while a clarification card is open (status=asking)', async () => {
    const id = await makeTask(OUTCOME); // outcome recorded (so not "processing")
    await db.insert(widgetClarifications).values({
      taskId: id, serverId: SERVER_ID, widgetUserId: WIDGET_USER_ID,
      agentId: '__auto__', command: '', status: 'asking', round: 0,
    });
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail!.processing).toBe(false); // a clarification exists
      expect(detail!.canAssign).toBe(false);  // ...so the Assign button is hidden
    } finally {
      await db.delete(widgetClarifications).where(eq(widgetClarifications.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});
