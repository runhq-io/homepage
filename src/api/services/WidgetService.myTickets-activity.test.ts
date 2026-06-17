/**
 * WidgetService.myTickets-activity.test.ts — verifies listMyTickets exposes a
 * lastActivityAt that reflects NEW COMMENTS, which do not bump the task's own
 * updatedAt. This is what lets the widget launcher badge light up for a team
 * reply on a user-submitted ticket.
 *
 * Self-contained setup (sets channelId) so it is unaffected by the
 * widget_projects.channel_id NOT NULL drift on the shared scratch DB.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects, widgetUsers } from '../../db/schema';
import { listMyTickets } from './WidgetService';
import * as WorkspaceTaskService from './WorkspaceTaskService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_mta_test_${RUN_HEX}`;
const USER_ID = `00000000-0007-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `MTA ${RUN_HEX}`, slug: `mta-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`,
    channelId: CHANNEL_ID, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-${RUN_HEX}`, name: 'Alice',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

afterAll(async () => {
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('listMyTickets lastActivityAt', () => {
  it('reflects a new comment even though it does not bump the task updatedAt', async () => {
    const [task] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title: 'My ticket',
      visibility: 'public', status: 'in_progress',
      sourceType: 'widget', createdByType: 'external', createdById: WIDGET_USER_ID,
    }).returning({ id: workspaceTasks.id, updatedAt: workspaceTasks.updatedAt });

    try {
      const before = await listMyTickets(PROJECT_ID, WIDGET_USER_ID);
      const row0 = before.find((t) => t.id === task!.id)!;
      expect(row0).toBeTruthy();
      // With no comments yet, lastActivityAt == updatedAt.
      expect(new Date(row0.lastActivityAt!).getTime()).toBe(new Date(row0.updatedAt).getTime());

      // A team comment does NOT bump workspace_tasks.updatedAt...
      await new Promise((r) => setTimeout(r, 10));
      await WorkspaceTaskService.addComment(SERVER_ID, task!.id, {
        content: 'Team reply', createdByType: 'member', createdById: USER_ID, createdByName: 'Team',
      });

      const after = await listMyTickets(PROJECT_ID, WIDGET_USER_ID);
      const row1 = after.find((t) => t.id === task!.id)!;
      // ...but lastActivityAt advances past updatedAt, so the badge can light up.
      expect(new Date(row1.lastActivityAt!).getTime()).toBeGreaterThan(new Date(row1.updatedAt).getTime());
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, task!.id));
    }
  });
});
