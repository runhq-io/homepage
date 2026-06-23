/**
 * WidgetService.canPreview.test.ts — integration coverage for the canPreview
 * flag on PublicTicketDetail.
 *
 * Self-contained setup: this suite sets channelId on its widget project (and
 * matching workspaceChannelId on its tasks) so it runs correctly regardless of
 * whether the scratch DB has widget_projects.channel_id nullable or NOT NULL —
 * a pattern established by WidgetService.milestones-detail.test.ts.
 *
 * canPreview is true only when BOTH conditions hold:
 *   1. The viewer's permissions include 'preview'.
 *   2. The ticket has a valid pr_linked activity (internalPr is non-null).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskActivity, widgetProjects } from '../../db/schema';
import { getPublicTicketDetail } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_cp_test_${RUN_HEX}`;
const USER_ID = `00000000-0007-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-cp-${RUN_HEX}`;
let PROJECT_ID: string;

const PR_ACTIVITY_METADATA = {
  number: 42,
  url: 'https://github.com/acme/web/pull/42',
  state: 'open',
  repoBranch: 'session/job-x/ticket-y',
};

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+cp+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv CP ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `CanPreview Test ${RUN_HEX}`,
    slug: `can-preview-${RUN_HEX}`,
    apiKey: `apikey-cp-${RUN_HEX}`,
    apiSecretHash: `secret-cp-${RUN_HEX}`,
    channelId: CHANNEL_ID,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

async function makeTask(title: string) {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    workspaceChannelId: CHANNEL_ID,
    title,
    visibility: 'public',
    status: 'in_progress',
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

async function linkPr(taskId: string) {
  await db.insert(workspaceTaskActivity).values({
    serverId: SERVER_ID,
    taskId,
    type: 'pr_linked',
    createdByType: 'system',
    metadata: PR_ACTIVITY_METADATA,
  });
}

describe('getPublicTicketDetail — canPreview field', () => {
  it('canPreview is true when permissions has preview AND a linked PR exists', async () => {
    const id = await makeTask('Preview-eligible task');
    await linkPr(id);
    try {
      const permissions = new Set<'preview'>(['preview']);
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, permissions);
      expect(detail).not.toBeNull();
      expect(detail!.canPreview).toBe(true);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canPreview is false when permissions lacks preview even if a linked PR exists', async () => {
    const id = await makeTask('No-live-coder task');
    await linkPr(id);
    try {
      const permissions = new Set<'assign_agent'>(['assign_agent']);
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, permissions);
      expect(detail).not.toBeNull();
      expect(detail!.canPreview).toBe(false);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canPreview is false when no permissions are passed (existing callers — default false)', async () => {
    const id = await makeTask('No-perms task');
    await linkPr(id);
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      expect(detail).not.toBeNull();
      expect(detail!.canPreview).toBe(false);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canPreview is false when preview is granted but no linked PR exists', async () => {
    const id = await makeTask('No-PR task for preview');
    try {
      const permissions = new Set<'preview'>(['preview']);
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, permissions);
      expect(detail).not.toBeNull();
      expect(detail!.canPreview).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});
