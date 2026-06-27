import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks } from '../../db/schema';
import { createTask } from './WorkspaceTaskService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_wt_test_${RUN_HEX}`;
const USER_ID = `00000000-0001-4000-a000-${RUN_HEX.padStart(12, '0')}`;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('createTask useWorktree', () => {
  it('persists and returns useWorktree=true', async () => {
    const task = await createTask(SERVER_ID, { title: 'wt on', useWorktree: true });
    expect(task.useWorktree).toBe(true);
  });

  it('defaults useWorktree to false when omitted', async () => {
    const task = await createTask(SERVER_ID, { title: 'wt default' });
    expect(task.useWorktree).toBe(false);
  });
});
