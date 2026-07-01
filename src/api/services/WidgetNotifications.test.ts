/**
 * WidgetNotifications: per-user pub/sub + notifyTaskAudience resolves the
 * reporter and the assigner and pings each of their channels.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users, servers, workspaceTasks, workspaceTaskActivity, widgetProjects, widgetUsers,
} from '../../db/schema';
import {
  subscribeToUser, publishToUser, userSubscriberCount, notifyTaskAudience,
} from './WidgetNotifications';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_ntf_${RUN_HEX}`;
const USER_ID = `00000000-000b-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
const ASSIGNER_EXT = `runhq:assigner-${RUN_HEX}`;
let PROJECT_ID: string;
let REPORTER_WUID: string;
let ASSIGNER_WUID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `NTF ${RUN_HEX}`, slug: `ntf-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [rep] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `runhq:reporter-${RUN_HEX}`, name: 'Reporter',
  }).returning({ id: widgetUsers.id });
  REPORTER_WUID = rep!.id;
  const [asn] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: ASSIGNER_EXT, name: 'Assigner',
  }).returning({ id: widgetUsers.id });
  ASSIGNER_WUID = asn!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('WidgetNotifications pub/sub', () => {
  it('publishToUser fires only that user\'s subscribers; unsubscribe cleans up', () => {
    let a = 0; let b = 0;
    const off = subscribeToUser('user-a', () => { a += 1; });
    subscribeToUser('user-b', () => { b += 1; });
    expect(userSubscriberCount('user-a')).toBe(1);

    publishToUser('user-a');
    expect(a).toBe(1);
    expect(b).toBe(0);

    off();
    expect(userSubscriberCount('user-a')).toBe(0);
    publishToUser('user-a'); // no throw, no-op
    expect(a).toBe(1);
  });
});

describe('notifyTaskAudience', () => {
  it('pings the reporter AND the assigner of the task', async () => {
    const [task] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title: 'Notif',
      visibility: 'public', status: 'in_progress',
      sourceType: 'widget', createdByType: 'external', createdById: REPORTER_WUID,
    }).returning({ id: workspaceTasks.id });
    await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID, taskId: task!.id, type: 'agent_assigned',
      metadata: { agentName: 'Coder' },
      createdByType: 'external', createdById: ASSIGNER_EXT, createdByName: 'Assigner',
    });

    let reporterPings = 0; let assignerPings = 0; let strangerPings = 0;
    const offR = subscribeToUser(REPORTER_WUID, () => { reporterPings += 1; });
    const offA = subscribeToUser(ASSIGNER_WUID, () => { assignerPings += 1; });
    const offS = subscribeToUser('stranger', () => { strangerPings += 1; });
    try {
      await notifyTaskAudience(task!.id);
      expect(reporterPings).toBe(1);
      expect(assignerPings).toBe(1);
      expect(strangerPings).toBe(0);
    } finally {
      offR(); offA(); offS();
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, task!.id));
    }
  });

  it('does no work and no throw when nobody is subscribed', async () => {
    await expect(notifyTaskAudience('00000000-0000-4000-a000-000000000000')).resolves.toBeUndefined();
  });
});
