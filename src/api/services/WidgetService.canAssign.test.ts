/**
 * WidgetService.canAssign.test.ts — integration coverage for the canAssign
 * flag on PublicTicketDetail. Mirrors WidgetService.canPreview.test.ts.
 *
 * canAssign is the signal the widget uses to show the "Assign agent" button.
 * It is true only when ALL hold:
 *   1. The viewer's permissions include 'assign_agent'.
 *   2. No agent is assigned yet (no agent_assigned activity).
 *   3. The ticket is in an actionable (non-terminal) status.
 *
 * Self-contained setup (channelId set) so it runs regardless of whether the
 * scratch DB has widget_projects.channel_id nullable or NOT NULL.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskActivity, widgetProjects } from '../../db/schema';
import { getPublicTicketDetail, type WidgetPermission } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ca_test_${RUN_HEX}`;
const USER_ID = `00000000-0009-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-ca-${RUN_HEX}`;
let PROJECT_ID: string;

const ASSIGN_PERM = new Set<WidgetPermission>(['assign_agent']);

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+ca+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv CA ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `CanAssign Test ${RUN_HEX}`,
    slug: `can-assign-${RUN_HEX}`,
    apiKey: `apikey-ca-${RUN_HEX}`,
    apiSecretHash: `secret-ca-${RUN_HEX}`,
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

async function makeTask(title: string, status: 'pending' | 'in_progress' | 'done' | 'cancelled' = 'pending') {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    workspaceChannelId: CHANNEL_ID,
    title,
    visibility: 'public',
    status,
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

async function assignAgentActivity(taskId: string) {
  await db.insert(workspaceTaskActivity).values({
    serverId: SERVER_ID,
    taskId,
    type: 'agent_assigned',
    createdByType: 'external',
    createdByName: 'Triager',
    metadata: { agentName: 'Coder' },
  });
}

describe('getPublicTicketDetail — canAssign field', () => {
  it('canAssign is true when the viewer holds assign_agent, no agent is assigned, and the status is actionable', async () => {
    const id = await makeTask('Unassigned actionable ticket');
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail).not.toBeNull();
      expect(detail!.canAssign).toBe(true);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canAssign is false when no permissions are passed (existing public callers)', async () => {
    const id = await makeTask('No-perms ticket');
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id);
      expect(detail).not.toBeNull();
      expect(detail!.canAssign).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canAssign is false once an agent has been assigned', async () => {
    const id = await makeTask('Already-assigned ticket', 'in_progress');
    await assignAgentActivity(id);
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail).not.toBeNull();
      expect(detail!.ticket.assignedAgentName).toBe('Coder');
      expect(detail!.canAssign).toBe(false);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });

  it('canAssign is false for a terminal status (done) even when unassigned', async () => {
    const id = await makeTask('Done ticket', 'done');
    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, id, undefined, ASSIGN_PERM);
      expect(detail).not.toBeNull();
      expect(detail!.canAssign).toBe(false);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, id));
    }
  });
});
