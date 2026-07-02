/**
 * Server-side widget unread read-state: markTicketReads upserts monotonically
 * (per-axis max, never regresses) and getTicketReads reads it back. This is what
 * lets the unread badge follow the user across devices.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users, servers, workspaceTasks, widgetProjects, widgetUsers,
} from '../../db/schema';
import { markTicketReads, getTicketReads } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_rd_${RUN_HEX}`;
const USER_ID = `00000000-000c-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;
let WUID: string;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `RD ${RUN_HEX}`, slug: `rd-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `runhq:${RUN_HEX}`, name: 'U',
  }).returning({ id: widgetUsers.id });
  WUID = wu!.id;
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title: 'RD',
    visibility: 'public', status: 'in_progress',
    sourceType: 'widget', createdByType: 'external', createdById: WUID,
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.id, TASK_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

const t = (ms: number) => new Date(ms);

describe('markTicketReads / getTicketReads', () => {
  it('upserts per-axis max and reads back; empty for unknown tasks', async () => {
    const base = Date.parse('2026-07-02T12:00:00Z');

    // First mark: general activity seen at base.
    await markTicketReads(WUID, [{ taskId: TASK_ID, seenAt: t(base) }]);
    let m = await getTicketReads(WUID, [TASK_ID]);
    expect(m.get(TASK_ID)!.seenAt!.getTime()).toBe(base);
    expect(m.get(TASK_ID)!.liveSessionSeenAt).toBeNull();

    // Earlier seenAt must NOT regress it.
    await markTicketReads(WUID, [{ taskId: TASK_ID, seenAt: t(base - 5000) }]);
    m = await getTicketReads(WUID, [TASK_ID]);
    expect(m.get(TASK_ID)!.seenAt!.getTime()).toBe(base);

    // Live-session axis is independent; setting it leaves seenAt intact.
    await markTicketReads(WUID, [{ taskId: TASK_ID, liveSessionSeenAt: t(base + 1000) }]);
    m = await getTicketReads(WUID, [TASK_ID]);
    expect(m.get(TASK_ID)!.seenAt!.getTime()).toBe(base);
    expect(m.get(TASK_ID)!.liveSessionSeenAt!.getTime()).toBe(base + 1000);

    // Later seenAt advances it.
    await markTicketReads(WUID, [{ taskId: TASK_ID, seenAt: t(base + 9000) }]);
    m = await getTicketReads(WUID, [TASK_ID]);
    expect(m.get(TASK_ID)!.seenAt!.getTime()).toBe(base + 9000);

    // Unknown / unmarked task ids simply don't appear.
    const none = await getTicketReads(WUID, []);
    expect(none.size).toBe(0);
  });
});
