/**
 * REPRO: the launcher badge must clear after viewing a ticket. The widget marks
 * a ticket "seen" using the max server timestamp shown in its detail; the badge
 * counts a ticket as unseen when listMyTickets.lastActivityAt > seen. So the
 * invariant is: detail-max >= mine.lastActivityAt for the same ticket. If this
 * fails, the badge never clears (the bug the user reported).
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, widgetProjects, widgetUsers } from '../../db/schema';
import { listMyTickets, getPublicTicketDetail } from './WidgetService';
import * as WorkspaceTaskService from './WorkspaceTaskService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_bc_${RUN_HEX}`;
const USER_ID = `00000000-0008-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const CHANNEL_ID = `chan-${RUN_HEX}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `BC ${RUN_HEX}`, slug: `bc-${RUN_HEX}`,
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

// Mirror the widget's renderDetailInto seen computation exactly.
function detailSeenMs(detail: any): number {
  let ms = new Date(detail.ticket.updatedAt || 0).getTime() || 0;
  for (const c of detail.comments || []) ms = Math.max(ms, new Date(c.createdAt || 0).getTime() || 0);
  for (const a of detail.activity || []) ms = Math.max(ms, new Date(a.createdAt || 0).getTime() || 0);
  return ms;
}

describe('REPRO launcher badge clears after viewing', () => {
  it('detail-seen >= mine.lastActivityAt (comment + activity + status change)', async () => {
    const [task] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, workspaceChannelId: CHANNEL_ID, title: 'Badge repro',
      visibility: 'public', status: 'pending',
      sourceType: 'widget', createdByType: 'external', createdById: WIDGET_USER_ID,
    }).returning({ id: workspaceTasks.id });

    try {
      // Simulate post-creation team activity: an activity row, a comment, a status change.
      await new Promise((r) => setTimeout(r, 5));
      await WorkspaceTaskService.addActivity(SERVER_ID, task!.id, {
        type: 'agent_assigned', metadata: { agentName: 'Coder' }, createdByType: 'system',
      });
      await new Promise((r) => setTimeout(r, 5));
      await WorkspaceTaskService.addComment(SERVER_ID, task!.id, {
        content: 'Team reply', createdByType: 'member', createdById: USER_ID, createdByName: 'Team',
      });
      await new Promise((r) => setTimeout(r, 5));
      await WorkspaceTaskService.updateTask(SERVER_ID, task!.id, { status: 'in_progress' });

      const mine = await listMyTickets(PROJECT_ID, WIDGET_USER_ID);
      const row = mine.find((t) => t.id === task!.id)!;
      const lastActivityMs = new Date(row.lastActivityAt!).getTime();

      const detail = await getPublicTicketDetail(PROJECT_ID, task!.id, WIDGET_USER_ID);
      const seenMs = detailSeenMs(detail);

      // The invariant the badge relies on. Log the gap for diagnosis.
      const gap = lastActivityMs - seenMs;
      console.log('[REPRO] lastActivityMs=%d seenMs=%d gap(ms)=%d', lastActivityMs, seenMs, gap);
      expect(seenMs).toBeGreaterThanOrEqual(lastActivityMs);
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, task!.id));
    }
  });
});
