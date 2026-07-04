/**
 * Integration tests for CommunityNotificationService.
 *
 * Pattern: Pattern A — real Neon test DB (DATABASE_URL from .env).
 * Each test runs against real rows; state is cleaned up in afterAll.
 * beforeEach resets widgetUserNotifications so each test starts fresh.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  widgetUserNotifications,
} from '../../db/schema';
import { CommunityNotificationService } from './CommunityNotificationService';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `cns_test_${RUN_HEX}`;
const USER_ID = `00000000-8888-4000-b000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
/** Primary caller widget user */
let WIDGET_USER_ID: string;
/** Secondary widget user for cross-user ownership tests */
let OTHER_WIDGET_USER_ID: string;

// ---------------------------------------------------------------------------
// Helper: insert a notification row directly for test setup
// ---------------------------------------------------------------------------
async function insertNotification(opts: {
  widgetUserId: string;
  type?: string;
  payload?: Record<string, unknown>;
  readAt?: Date | null;
  createdAt?: Date;
}) {
  const [row] = await db
    .insert(widgetUserNotifications)
    .values({
      widgetUserId: opts.widgetUserId,
      projectId: PROJECT_ID,
      type: opts.type ?? 'points.awarded',
      payload: opts.payload ?? { amount: 10 },
      readAt: opts.readAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Seed: create structural fixtures once; reset notification rows between tests
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: USER_ID, email: `cns+${RUN_HEX}@test.invalid`, name: 'CNS Test' })
    .onConflictDoNothing();
  await db
    .insert(servers)
    .values({ id: SERVER_ID, name: `CNS Srv ${RUN_HEX}`, ownerId: USER_ID })
    .onConflictDoNothing();
  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId: SERVER_ID,
      name: `CNS Project ${RUN_HEX}`,
      slug: `cns-${RUN_HEX}`,
      apiKey: `apikey-cns-${RUN_HEX}`,
      apiSecretHash: `secret-cns-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    })
    .returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db
    .insert(widgetUsers)
    .values({ projectId: PROJECT_ID, externalUserId: `cns-a-${RUN_HEX}`, name: 'Alice' })
    .returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;

  const [wu2] = await db
    .insert(widgetUsers)
    .values({ projectId: PROJECT_ID, externalUserId: `cns-b-${RUN_HEX}`, name: 'Bob' })
    .returning({ id: widgetUsers.id });
  OTHER_WIDGET_USER_ID = wu2!.id;
});

afterAll(async () => {
  await db
    .delete(widgetUserNotifications)
    .where(eq(widgetUserNotifications.projectId, PROJECT_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  await db
    .delete(widgetUserNotifications)
    .where(eq(widgetUserNotifications.projectId, PROJECT_ID));
});

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------
function makeService() {
  return new CommunityNotificationService({ db });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
describe('list', () => {
  it('returns rows newest-first', async () => {
    const svc = makeService();
    // Insert with explicit timestamps to guarantee ordering
    const t1 = new Date('2024-01-01T10:00:00.000Z');
    const t2 = new Date('2024-01-01T11:00:00.000Z');
    const t3 = new Date('2024-01-01T12:00:00.000Z');
    await insertNotification({ widgetUserId: WIDGET_USER_ID, createdAt: t1, payload: { idx: 1 } });
    await insertNotification({ widgetUserId: WIDGET_USER_ID, createdAt: t2, payload: { idx: 2 } });
    await insertNotification({ widgetUserId: WIDGET_USER_ID, createdAt: t3, payload: { idx: 3 } });

    const { notifications, nextCursor } = await svc.list({
      widgetUserId: WIDGET_USER_ID,
      limit: 10,
    });

    expect(notifications).toHaveLength(3);
    // Newest first: idx 3, 2, 1
    expect((notifications[0]!.payload as any).idx).toBe(3);
    expect((notifications[1]!.payload as any).idx).toBe(2);
    expect((notifications[2]!.payload as any).idx).toBe(1);
    expect(nextCursor).toBeNull();
  });

  it('returns empty array + nextCursor null when no notifications exist', async () => {
    const svc = makeService();
    const { notifications, nextCursor } = await svc.list({
      widgetUserId: WIDGET_USER_ID,
      limit: 10,
    });
    expect(notifications).toHaveLength(0);
    expect(nextCursor).toBeNull();
  });

  it('cursor pagination: 5 rows, limit=2 pages through correctly with no repeats', async () => {
    const svc = makeService();
    // Insert 5 notifications with distinct timestamps spread 1 minute apart
    const base = new Date('2024-06-01T00:00:00.000Z').getTime();
    for (let i = 1; i <= 5; i++) {
      await insertNotification({
        widgetUserId: WIDGET_USER_ID,
        createdAt: new Date(base + i * 60_000),
        payload: { seq: i },
      });
    }

    // Page 1 — should return seq 5, 4 (newest first) + a cursor
    const page1 = await svc.list({ widgetUserId: WIDGET_USER_ID, limit: 2 });
    expect(page1.notifications).toHaveLength(2);
    expect((page1.notifications[0]!.payload as any).seq).toBe(5);
    expect((page1.notifications[1]!.payload as any).seq).toBe(4);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 — cursor from page 1; should return seq 3, 2 + a cursor; NO repeats of seq 4/5
    const page2 = await svc.list({
      widgetUserId: WIDGET_USER_ID,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.notifications).toHaveLength(2);
    expect((page2.notifications[0]!.payload as any).seq).toBe(3);
    expect((page2.notifications[1]!.payload as any).seq).toBe(2);
    expect(page2.nextCursor).not.toBeNull();

    // Page 3 — cursor from page 2; should return seq 1 + nextCursor null
    const page3 = await svc.list({
      widgetUserId: WIDGET_USER_ID,
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.notifications).toHaveLength(1);
    expect((page3.notifications[0]!.payload as any).seq).toBe(1);
    expect(page3.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// markRead
// ---------------------------------------------------------------------------
describe('markRead', () => {
  it('sets read_at on a single notification owned by the caller', async () => {
    const svc = makeService();
    const notif = await insertNotification({ widgetUserId: WIDGET_USER_ID });

    const result = await svc.markRead({
      widgetUserId: WIDGET_USER_ID,
      notificationId: notif.id,
    });
    expect(result).toEqual({ ok: true });

    // Verify read_at was set
    const [updated] = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.id, notif.id));
    expect(updated!.readAt).not.toBeNull();
  });

  it('throws Forbidden when notificationId belongs to a different widget user', async () => {
    const svc = makeService();
    // Notification owned by OTHER user
    const otherNotif = await insertNotification({ widgetUserId: OTHER_WIDGET_USER_ID });

    // Caller (WIDGET_USER_ID) tries to mark it read — should throw Forbidden
    await expect(
      svc.markRead({ widgetUserId: WIDGET_USER_ID, notificationId: otherNotif.id }),
    ).rejects.toThrow('Forbidden');
  });

  it("throws 'Notification not found' when the id doesn't exist", async () => {
    const svc = makeService();
    await expect(
      svc.markRead({
        widgetUserId: WIDGET_USER_ID,
        notificationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow('Notification not found');
  });

  it('re-marking an already-read notification is a no-op success (read_at unchanged)', async () => {
    const svc = makeService();
    const priorReadAt = new Date('2024-03-15T10:00:00.000Z');
    const notif = await insertNotification({ widgetUserId: WIDGET_USER_ID, readAt: priorReadAt });

    const result = await svc.markRead({
      widgetUserId: WIDGET_USER_ID,
      notificationId: notif.id,
    });
    expect(result).toEqual({ ok: true });

    // read_at must be unchanged from its prior value
    const [row] = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.id, notif.id));
    expect(row!.readAt?.toISOString()).toBe(priorReadAt.toISOString());
  });
});

// ---------------------------------------------------------------------------
// markAllRead
// ---------------------------------------------------------------------------
describe('markAllRead', () => {
  it('marks all unread notifications for the caller; returns correct markedCount', async () => {
    const svc = makeService();
    // 3 unread for caller
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });

    const result = await svc.markAllRead({ widgetUserId: WIDGET_USER_ID });
    expect(result.ok).toBe(true);
    expect(result.markedCount).toBe(3);

    // Verify all are now read
    const rows = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it("does NOT touch notifications belonging to other widget users", async () => {
    const svc = makeService();
    // 1 unread for caller, 1 unread for other
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    const otherNotif = await insertNotification({ widgetUserId: OTHER_WIDGET_USER_ID });

    await svc.markAllRead({ widgetUserId: WIDGET_USER_ID });

    // Other user's notification should still be unread
    const [otherRow] = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.id, otherNotif.id));
    expect(otherRow!.readAt).toBeNull();
  });

  it("does NOT re-touch already-read notifications (markedCount only counts freshly-marked ones)", async () => {
    const svc = makeService();
    const alreadyReadAt = new Date('2024-04-01T09:00:00.000Z');
    // 1 already-read, 2 unread
    const alreadyRead = await insertNotification({
      widgetUserId: WIDGET_USER_ID,
      readAt: alreadyReadAt,
    });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });

    const result = await svc.markAllRead({ widgetUserId: WIDGET_USER_ID });
    expect(result.markedCount).toBe(2); // only the 2 previously unread

    // The pre-existing read_at must be preserved
    const [alreadyReadRow] = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.id, alreadyRead.id));
    expect(alreadyReadRow!.readAt?.toISOString()).toBe(alreadyReadAt.toISOString());
  });
});

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------
describe('unreadCount', () => {
  it('returns 0 when no notifications exist', async () => {
    const svc = makeService();
    const count = await svc.unreadCount(WIDGET_USER_ID);
    expect(count).toBe(0);
  });

  it('returns count of unread, ignoring read ones', async () => {
    const svc = makeService();
    // 3 unread, 2 read
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID, readAt: new Date() });
    await insertNotification({ widgetUserId: WIDGET_USER_ID, readAt: new Date() });

    const count = await svc.unreadCount(WIDGET_USER_ID);
    expect(count).toBe(3);
  });

  it("is scoped to the calling widgetUserId only (other users' unread don't count)", async () => {
    const svc = makeService();
    // 2 unread for caller, 5 unread for other
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    await insertNotification({ widgetUserId: WIDGET_USER_ID });
    for (let i = 0; i < 5; i++) {
      await insertNotification({ widgetUserId: OTHER_WIDGET_USER_ID });
    }

    const count = await svc.unreadCount(WIDGET_USER_ID);
    expect(count).toBe(2);
  });
});
