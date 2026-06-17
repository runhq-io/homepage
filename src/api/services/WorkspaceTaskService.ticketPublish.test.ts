/**
 * WorkspaceTaskService.ticketPublish.test.ts — verifies the real-time publish
 * hook fires for live widget ticket-status subscribers on the two canonical
 * write paths (addActivity, updateTask). Uses only a server + task row (no
 * widget project), so it is unaffected by widget_projects schema drift on the
 * shared scratch DB.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks } from '../../db/schema';
import * as WorkspaceTaskService from './WorkspaceTaskService';
import { subscribeToTicket } from './WidgetTicketEvents';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_tp_test_${RUN_HEX}`;
const USER_ID = `00000000-0006-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Publish hook task', visibility: 'public', status: 'pending',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.id, TASK_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('WorkspaceTaskService publish hooks', () => {
  it('addActivity notifies live ticket subscribers', async () => {
    let fired = 0;
    const unsub = subscribeToTicket(TASK_ID, () => { fired += 1; });
    try {
      await WorkspaceTaskService.addActivity(SERVER_ID, TASK_ID, {
        type: 'status_change', metadata: { from: 'pending', to: 'in_progress' }, createdByType: 'system',
      });
      expect(fired).toBeGreaterThanOrEqual(1);
    } finally {
      unsub();
    }
  });

  it('updateTask notifies live ticket subscribers', async () => {
    let fired = 0;
    const unsub = subscribeToTicket(TASK_ID, () => { fired += 1; });
    try {
      await WorkspaceTaskService.updateTask(SERVER_ID, TASK_ID, { status: 'in_progress' });
      expect(fired).toBeGreaterThanOrEqual(1);
    } finally {
      unsub();
    }
  });

  it('does not notify subscribers of a different ticket', async () => {
    let fired = 0;
    const unsub = subscribeToTicket('some-other-task-id', () => { fired += 1; });
    try {
      await WorkspaceTaskService.addActivity(SERVER_ID, TASK_ID, { type: 'comment', content: 'hi', createdByType: 'system' });
      expect(fired).toBe(0);
    } finally {
      unsub();
    }
  });
});
