import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  workspaceTasks,
  notifications,
  notificationDeliveries,
  userNotificationPreferences,
} from '../../db/schema';
import { updateTask } from './WorkspaceTaskService';

/**
 * Real-path integration test for the channel_id + job_id snapshot on
 * notifications. This is the exact code path PATCH
 * /api/server/workspace-tasks/:id takes: WorkspaceTaskService.updateTask →
 * emitTaskNotification → insertNotificationWithDeliveries → notifications row.
 *
 * Covers the bug the user hit ("clicking notification opens todo list, not the
 * job"): a transition that should emit MUST capture the workspace job id from
 * the input so the wire notification carries it and the client can deep-link
 * to /session/:jobId.
 */
const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_notifjob_${RUN_HEX}`;
const CREATOR_ID = `00000000-0001-4000-a100-${RUN_HEX.padStart(12, '0')}`;
const ACTOR_ID   = `00000000-0001-4000-a200-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `ch_notifjob_${RUN_HEX}`;
const JOB_ID     = `job_notifjob_${RUN_HEX}`;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values([
    { id: CREATOR_ID, email: `creator+${RUN_HEX}@test.invalid`, name: 'Creator' },
    { id: ACTOR_ID,   email: `actor+${RUN_HEX}@test.invalid`,   name: 'Actor'   },
  ]).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: CREATOR_ID }).onConflictDoNothing();
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    title: 'Needs help on this',
    status: 'in_progress',
    workspaceChannelId: CHANNEL_ID,
    createdById: CREATOR_ID,
  }).returning({ id: workspaceTasks.id });
  if (!task) throw new Error('seed failed');
  TASK_ID = task.id;
});

afterAll(async () => {
  const notifIds = (await db.select({ id: notifications.id }).from(notifications)
    .where(eq(notifications.serverId, SERVER_ID))).map(r => r.id);
  if (notifIds.length) {
    await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.notificationId, notifIds));
    await db.delete(notifications).where(inArray(notifications.id, notifIds));
  }
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(userNotificationPreferences).where(inArray(userNotificationPreferences.userId, [CREATOR_ID, ACTOR_ID]));
  await db.delete(users).where(inArray(users.id, [CREATOR_ID, ACTOR_ID]));
});

describe('updateTask → notification snapshot', () => {
  it('snapshots workspaceChannelId AND workspaceJobId onto the notification when a status transition fires', async () => {
    // Agent (not the creator) flips it to needs_review and supplies the job id.
    // This mirrors what the workspace server's CanonicalTaskApiClient does on
    // every PATCH after the resolver is wired.
    const { task, notification } = await updateTask(
      SERVER_ID,
      TASK_ID,
      { status: 'needs_review', workspaceJobId: JOB_ID },
      { type: 'agent' },
    );

    expect(task).not.toBeNull();
    expect(notification).not.toBeNull();
    expect(notification!.channel_id).toBe(CHANNEL_ID);
    expect(notification!.job_id).toBe(JOB_ID);

    // And persisted on the row, not just on the wire.
    const [row] = await db.select().from(notifications).where(eq(notifications.id, notification!.id));
    expect(row.channelId).toBe(CHANNEL_ID);
    expect(row.jobId).toBe(JOB_ID);
  });
});
