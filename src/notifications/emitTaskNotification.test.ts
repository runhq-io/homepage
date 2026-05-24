import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import {
  users,
  servers,
  notifications,
  notificationDeliveries,
  pushSubscriptions,
  workspaceTasks,
} from '@/db';
import { emitTaskNotification, insertNotificationWithDeliveries, type NotificationActor, type TaskRowForNotification } from './emitTaskNotification';

// ─── Stable test fixture IDs ─────────────────────────────────────────────────
// Using deterministic UUIDs so cleanup is straightforward.

const TEST_USER_1    = '00000000-0000-0000-0000-aaaabbbb0001'; // "last interactor / creator"
const TEST_USER_2    = '00000000-0000-0000-0000-aaaabbbb0002'; // "actor / other user"
const TEST_SERVER_ID = 'ws_test_notify_001';                    // text server id
const TEST_PROJECT   = 'proj_test_notify_001';                  // free-form project id
const TEST_CHANNEL   = 'ch_test_notify_001';                    // free-form channel id
const TEST_JOB       = 'job_test_notify_001';                   // free-form job/session id
const TEST_TASK_ID   = '00000000-0000-0000-0000-cccc00000001'; // must be uuid

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a TaskRowForNotification fixture with sensible defaults. */
function makeRow(overrides?: Partial<TaskRowForNotification>): TaskRowForNotification {
  return {
    id: TEST_TASK_ID,
    serverId: TEST_SERVER_ID,
    workspaceProjectId: TEST_PROJECT,
    workspaceChannelId: TEST_CHANNEL,
    workspaceJobId: TEST_JOB,
    workspaceProjectName: null,
    title: 'Fix the login bug',
    createdById: TEST_USER_1,
    lastInteractorUserId: null,
    ...overrides,
  };
}

/** Call emitTaskNotification inside a real transaction and commit it. */
async function emit(
  row: TaskRowForNotification,
  prev: TaskRowForNotification,
  newStatus: 'needs_review' | 'done',
  actor: NotificationActor,
): Promise<string | null> {
  let result: string | null = null;
  await db.transaction(async (tx) => {
    result = await emitTaskNotification(tx, row, prev, newStatus, actor);
  });
  return result;
}

// ─── Fixture setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  // Delete all notification-related rows for our test fixtures.
  const notifRows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.serverId, TEST_SERVER_ID));
  const notifIds = notifRows.map((r) => r.id);
  if (notifIds.length > 0) {
    await db.delete(notificationDeliveries).where(
      inArray(notificationDeliveries.notificationId, notifIds),
    );
    await db.delete(notifications).where(
      inArray(notifications.id, notifIds),
    );
  }

  await db.delete(pushSubscriptions).where(
    inArray(pushSubscriptions.userId, [TEST_USER_1, TEST_USER_2]),
  );

  // Upsert test users (they may already exist from a prior run).
  await db
    .insert(users)
    .values([
      { id: TEST_USER_1, email: 'notify-user1@test.example' } as any,
      { id: TEST_USER_2, email: 'notify-user2@test.example' } as any,
    ])
    .onConflictDoNothing();

  // Upsert test server (text id).
  await db
    .insert(servers)
    .values({ id: TEST_SERVER_ID, name: 'Test Notify Server', ownerId: TEST_USER_1 } as any)
    .onConflictDoNothing();
});

afterAll(async () => {
  // Full cleanup of all fixture data.
  const notifRows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.serverId, TEST_SERVER_ID));
  const notifIds = notifRows.map((r) => r.id);
  if (notifIds.length > 0) {
    await db.delete(notificationDeliveries).where(
      inArray(notificationDeliveries.notificationId, notifIds),
    );
    await db.delete(notifications).where(
      inArray(notifications.id, notifIds),
    );
  }
  await db.delete(pushSubscriptions).where(
    inArray(pushSubscriptions.userId, [TEST_USER_1, TEST_USER_2]),
  );
  await db.delete(servers).where(eq(servers.id, TEST_SERVER_ID));
  await db.delete(users).where(inArray(users.id, [TEST_USER_1, TEST_USER_2]));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('emitTaskNotification', () => {
  // 1. Transition to needs_review with last_interactor set
  it('emits need_help when transitioning to needs_review with lastInteractor set', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'needs_review', { type: 'agent' });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.eventType).toBe('need_help');
    expect(notif.userId).toBe(TEST_USER_1);
  });

  // 2. Transition to done with last_interactor set
  it('emits completed when transitioning to done with lastInteractor set', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.eventType).toBe('completed');
    expect(notif.userId).toBe(TEST_USER_1);
  });

  // 3. Falls back to createdById when no lastInteractor
  it('falls back to createdById when lastInteractorUserId is null', async () => {
    const row = makeRow({ lastInteractorUserId: null, createdById: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: null, createdById: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.userId).toBe(TEST_USER_1);
  });

  // 4. No recipient at all → no notification
  it('returns null when both lastInteractorUserId and createdById are null', async () => {
    const row = makeRow({ lastInteractorUserId: null, createdById: null });
    const prev = makeRow({ lastInteractorUserId: null, createdById: null });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).toBeNull();
  });

  // 5. Self-suppression: actor user === recipient → no notification
  it('suppresses notification when actor user is the recipient', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'needs_review', { type: 'user', userId: TEST_USER_1 });

    expect(id).toBeNull();
  });

  // 6. Different user causes transition → notification fires
  it('emits notification when actor is a different user from the recipient', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'user', userId: TEST_USER_2 });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.userId).toBe(TEST_USER_1);
  });

  // 7. Project is contextual, not required: a task with no project (e.g. a
  // todo created directly in a channel) STILL emits. The notification falls
  // back to an empty project id/name and the client omits the project segment.
  it('still emits when workspaceProjectId is null (project is contextual)', async () => {
    const row = makeRow({ workspaceProjectId: null });
    const prev = makeRow({ workspaceProjectId: null });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.projectId).toBe('');
    expect(notif.projectName).toBe('');
  });

  // 8. agent actor → self-suppression does not apply
  it('emits notification when actor is agent (no self-suppression)', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
  });

  // 9. Delivery rows created with no push subscriptions: exactly 3
  it('creates exactly 3 delivery rows (in_app, browser_api, email) when no push subs', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id!));
    expect(deliveries).toHaveLength(3);
    const channels = deliveries.map((d) => d.channel).sort();
    expect(channels).toEqual(['browser_api', 'email', 'in_app']);
    // All pending
    expect(deliveries.every((d) => d.status === 'pending')).toBe(true);
  });

  // 10. Delivery rows include web_push when user has a web_push subscription
  it('creates 4 delivery rows including web_push when user has a web_push subscription', async () => {
    await db.insert(pushSubscriptions).values({
      userId: TEST_USER_1,
      platform: 'web_push',
      endpoint: 'https://fcm.googleapis.com/test-endpoint-notify',
      keys: { p256dh: 'abc', auth: 'def' },
    } as any);

    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id!));
    expect(deliveries).toHaveLength(4);
    const channels = deliveries.map((d) => d.channel).sort();
    expect(channels).toContain('web_push');
  });

  // 11. Snapshot fields are populated correctly
  it('populates snapshot fields (serverName, projectName, taskTitle) in the notification row', async () => {
    const row = makeRow({
      lastInteractorUserId: TEST_USER_1,
      title: 'My Snapshot Task',
    });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));

    // serverName should be the server's name, not just the ID
    expect(notif.serverName).toBe('Test Notify Server');

    // projectName is the projectId (no separate projects table)
    expect(notif.projectName).toBe(TEST_PROJECT);
    expect(notif.projectId).toBe(TEST_PROJECT);

    // taskTitle snapshot
    expect(notif.taskTitle).toBe('My Snapshot Task');

    // taskId snapshot
    expect(notif.taskId).toBe(TEST_TASK_ID);
  });

  // 12. Idempotency: two distinct transitions create two distinct notification rows
  it('creates distinct notification rows for two different status transitions', async () => {
    const row1 = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev1 = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id1 = await emit(row1, prev1, 'needs_review', { type: 'agent' });

    const row2 = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev2 = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id2 = await emit(row2, prev2, 'done', { type: 'agent' });

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);

    const allNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.serverId, TEST_SERVER_ID));
    expect(allNotifs.length).toBeGreaterThanOrEqual(2);
  });

  // 13. system actor: self-suppression does not apply (system has no userId)
  it('emits notification when actor is system (no self-suppression)', async () => {
    const row = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const prev = makeRow({ lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'needs_review', { type: 'system' });

    expect(id).not.toBeNull();
  });

  // 14. Unknown server → returns null (defensive guard)
  it('returns null when the server does not exist in the DB', async () => {
    const row = makeRow({
      serverId: 'ws_nonexistent_server_xyz',
      lastInteractorUserId: TEST_USER_1,
    });
    const prev = makeRow({ serverId: 'ws_nonexistent_server_xyz', lastInteractorUserId: TEST_USER_1 });
    const id = await emit(row, prev, 'done', { type: 'agent' });

    expect(id).toBeNull();
  });

  // ─── Test-notification path (POST /api/notifications/test) ────────────────
  // The test endpoint reuses the exact same delivery core via
  // insertNotificationWithDeliveries with synthetic 'test' content (no server
  // existence check, empty project), then dispatches through processDelivery.

  it('test-notification content inserts a notification + delivery rows for the caller', async () => {
    // Clean any prior synthetic test rows for this user (serverId 'test').
    const prior = await db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.userId, TEST_USER_1), eq(notifications.serverId, 'test')));
    if (prior.length) await db.delete(notifications).where(inArray(notifications.id, prior.map(r => r.id)));

    let id: string | null = null;
    await db.transaction(async (tx) => {
      id = await insertNotificationWithDeliveries(tx, {
        userId: TEST_USER_1,
        serverId: 'test',
        serverName: 'Test',
        projectId: '',
        projectName: '',
        taskId: '00000000-0000-0000-0000-cccc00000099',
        taskTitle: 'This is a test notification 🔔',
        channelId: TEST_CHANNEL,
        jobId: TEST_JOB,
        eventType: 'completed',
      });
    });

    expect(id).not.toBeNull();
    const [notif] = await db.select().from(notifications).where(eq(notifications.id, id!));
    expect(notif.serverId).toBe('test');
    expect(notif.projectId).toBe('');
    expect(notif.taskTitle).toBe('This is a test notification 🔔');
    expect(notif.channelId).toBe(TEST_CHANNEL);
    expect(notif.jobId).toBe(TEST_JOB);

    // No push subscription for TEST_USER_1 → exactly in_app + browser_api + email.
    const dels = await db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id!));
    expect(dels.map(d => d.channel).sort()).toEqual(['browser_api', 'email', 'in_app']);
    expect(dels.every(d => d.status === 'pending')).toBe(true);

    await db.delete(notifications).where(eq(notifications.id, id!));
  });

  it('test-notification includes a web_push delivery when the caller has a web_push device', async () => {
    await db.insert(pushSubscriptions).values({
      userId: TEST_USER_1,
      platform: 'web_push',
      endpoint: 'https://example.com/ep-test-notify',
      keys: { p256dh: 'k', auth: 'a' },
    }).onConflictDoNothing();

    let id: string | null = null;
    await db.transaction(async (tx) => {
      id = await insertNotificationWithDeliveries(tx, {
        userId: TEST_USER_1,
        serverId: 'test',
        serverName: 'Test',
        projectId: '',
        projectName: '',
        taskId: '00000000-0000-0000-0000-cccc00000099',
        taskTitle: 'Push test 🔔',
        channelId: null,
        jobId: null,
        eventType: 'completed',
      });
    });

    const dels = await db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id!));
    expect(dels.map(d => d.channel).sort()).toEqual(['browser_api', 'email', 'in_app', 'web_push']);

    await db.delete(notifications).where(eq(notifications.id, id!));
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, TEST_USER_1));
  });
});
