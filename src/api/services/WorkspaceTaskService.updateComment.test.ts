import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments } from '../../db/schema';
import { addComment, updateComment } from './WorkspaceTaskService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_upd_test_${RUN_HEX}`;
const USER_ID = `00000000-0001-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let TASK_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [task] = await db.insert(workspaceTasks).values({ serverId: SERVER_ID, title: 'T' }).returning({ id: workspaceTasks.id });
  if (!task) throw new Error('seed failed');
  TASK_ID = task.id;
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('updateComment', () => {
  it('updates content and bumps updatedAt', async () => {
    const created = await addComment(SERVER_ID, TASK_ID, { content: 'original', createdByType: 'external' });
    await new Promise(r => setTimeout(r, 20));
    const updated = await updateComment(SERVER_ID, TASK_ID, created.id, { content: 'edited' });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe('edited');
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('returns null for unknown commentId', async () => {
    const result = await updateComment(SERVER_ID, TASK_ID, '00000000-0000-0000-0000-000000000000', { content: 'x' });
    expect(result).toBeNull();
  });

  it('returns null for soft-deleted comments', async () => {
    const created = await addComment(SERVER_ID, TASK_ID, { content: 'to-delete', createdByType: 'external' });
    await db.update(workspaceTaskComments).set({ deletedAt: new Date() }).where(eq(workspaceTaskComments.id, created.id));
    const result = await updateComment(SERVER_ID, TASK_ID, created.id, { content: 'x' });
    expect(result).toBeNull();
  });
});
