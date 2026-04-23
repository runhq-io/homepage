import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments, widgetProjects, widgetUsers } from '../../db/schema';
import { addWidgetComment, updateWidgetComment, deleteWidgetComment, addWidgetCommentAttachment } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_cmt_test_${RUN_HEX}`;
const USER_ID = `00000000-0004-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let TASK_ID: string;
let WIDGET_USER_ID: string;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID, name: `Cmt Test ${RUN_HEX}`, slug: `cmt-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`, apiSecretHash: `secret-${RUN_HEX}`, enabled: true, isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID, externalUserId: `ext-${RUN_HEX}`, name: 'Author',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
  const [t] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'T', visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = t!.id;
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

describe('addWidgetComment', () => {
  it('creates a comment with createdByType=external and createdById=widgetUserId', async () => {
    const result = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'Hello from widget');
    expect(result.body).toBe('Hello from widget');
    expect(result.createdByType).toBe('external');
    expect(result.isAuthorOfCurrentUser).toBe(true);
    const [row] = await db.select().from(workspaceTaskComments).where(eq(workspaceTaskComments.id, result.id));
    expect(row.createdById).toBe(WIDGET_USER_ID);
    expect(row.createdByType).toBe('external');
  });

  it('throws Ticket not found when ticket does not exist in this project', async () => {
    await expect(
      addWidgetComment(PROJECT_ID, '00000000-0000-0000-0000-000000000000', WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Ticket not found');
  });

  it('throws Ticket not found when ticket is private', async () => {
    const [priv] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Priv', visibility: 'private',
    }).returning({ id: workspaceTasks.id });
    await expect(
      addWidgetComment(PROJECT_ID, priv!.id, WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Ticket not found');
  });

  it('uses the widget user name from widget_users.name as createdByName', async () => {
    const result = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'second');
    expect(result.authorName).toBe('Author');
  });
});

describe('updateWidgetComment', () => {
  it('updates content when widgetUserId matches the author', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'original');
    await new Promise(r => setTimeout(r, 20));
    const updated = await updateWidgetComment(PROJECT_ID, TASK_ID, created.id, WIDGET_USER_ID, 'edited');
    expect(updated.body).toBe('edited');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
  });

  it('throws Not the comment author when widgetUserId is different', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'x');
    const [otherUser] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-other-${RUN_HEX}`, name: 'Other',
    }).returning({ id: widgetUsers.id });
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, created.id, otherUser!.id, 'hacked')
    ).rejects.toThrow('Not the comment author');
  });

  it('throws Not the comment author when comment is by a member (not external)', async () => {
    const [memberComment] = await db.insert(workspaceTaskComments).values({
      serverId: SERVER_ID, taskId: TASK_ID, content: 'member',
      createdByType: 'member', createdById: USER_ID, createdByName: 'M', updatedAt: new Date(),
    }).returning({ id: workspaceTaskComments.id });
    // Even if widgetUserId happens to equal USER_ID (collision), widget users cannot edit member comments
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, memberComment!.id, USER_ID, 'spoof')
    ).rejects.toThrow('Not the comment author');
  });

  it('throws Comment not found for unknown id', async () => {
    await expect(
      updateWidgetComment(PROJECT_ID, TASK_ID, '00000000-0000-0000-0000-000000000000', WIDGET_USER_ID, 'x')
    ).rejects.toThrow('Comment not found');
  });
});

describe('deleteWidgetComment', () => {
  it('soft-deletes when widgetUserId matches the author', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'to-delete');
    await deleteWidgetComment(PROJECT_ID, TASK_ID, created.id, WIDGET_USER_ID);
    const [row] = await db.select().from(workspaceTaskComments).where(eq(workspaceTaskComments.id, created.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it('throws Not the comment author when widgetUserId is different', async () => {
    const created = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'mine');
    const [other] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-o2-${RUN_HEX}`, name: 'O',
    }).returning({ id: widgetUsers.id });
    await expect(
      deleteWidgetComment(PROJECT_ID, TASK_ID, created.id, other!.id)
    ).rejects.toThrow('Not the comment author');
  });
});

describe('addWidgetCommentAttachment', () => {
  it('rejects when widgetUserId is not the comment author (auth check runs first)', async () => {
    const comment = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'with attachment');
    const [other] = await db.insert(widgetUsers).values({
      projectId: PROJECT_ID, externalUserId: `ext-att-${RUN_HEX}`, name: 'O',
    }).returning({ id: widgetUsers.id });
    await expect(
      addWidgetCommentAttachment(PROJECT_ID, TASK_ID, comment.id, other!.id, {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png',
        filename: 'test.png',
      })
    ).rejects.toThrow('Not the comment author');
  });

  it('rejects invalid mime types for the comment author', async () => {
    const comment = await addWidgetComment(PROJECT_ID, TASK_ID, WIDGET_USER_ID, 'wrong type');
    await expect(
      addWidgetCommentAttachment(PROJECT_ID, TASK_ID, comment.id, WIDGET_USER_ID, {
        buffer: Buffer.from([0]),
        mimeType: 'application/x-shellscript',
        filename: 'evil.sh',
      })
    ).rejects.toThrow(/image files are allowed/);
  });
});
