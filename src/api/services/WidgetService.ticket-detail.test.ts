import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments, widgetProjects, widgetUsers } from '../../db/schema';
import { getPublicTicketDetail } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `ws_td_test_${RUN_HEX}`;
const USER_ID = `00000000-0003-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let TASK_ID: string;
let WIDGET_USER_ID: string;
const EXTERNAL_USER_ID = `ext-${RUN_HEX}`;

beforeAll(async () => {
  await db.insert(users).values({ id: USER_ID, email: `u+${RUN_HEX}@test.invalid`, name: 'U' }).onConflictDoNothing();
  await db.insert(servers).values({ id: SERVER_ID, name: `Srv ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `Detail Test ${RUN_HEX}`,
    slug: `detail-test-${RUN_HEX}`,
    apiKey: `apikey-${RUN_HEX}`,
    apiSecretHash: `secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [widgetUser] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: EXTERNAL_USER_ID,
    name: 'Alice',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = widgetUser!.id;

  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID, title: 'Test task', visibility: 'public', status: 'in_progress',
  }).returning({ id: workspaceTasks.id });
  TASK_ID = task!.id;

  await db.insert(workspaceTaskComments).values([
    { serverId: SERVER_ID, taskId: TASK_ID, content: 'External comment', createdByType: 'external', createdById: WIDGET_USER_ID, createdByName: 'Alice', updatedAt: new Date() },
    { serverId: SERVER_ID, taskId: TASK_ID, content: 'Member comment',   createdByType: 'member',   createdById: USER_ID,        createdByName: 'RunHQ User', updatedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
});

describe('getPublicTicketDetail comment payload', () => {
  it('includes createdByType and externalUserId for external comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    expect(detail).not.toBeNull();
    const external = detail!.comments.find(c => c.body === 'External comment')!;
    expect(external.createdByType).toBe('external');
    expect(external.externalUserId).toBe(EXTERNAL_USER_ID);
  });

  it('leaves externalUserId null for member comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const member = detail!.comments.find(c => c.body === 'Member comment')!;
    expect(member.createdByType).toBe('member');
    expect(member.externalUserId).toBeNull();
  });

  it('sets isAuthorOfCurrentUser=true for the current widget user\'s external comment', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const own = detail!.comments.find(c => c.body === 'External comment')!;
    expect(own.isAuthorOfCurrentUser).toBe(true);
    expect(own.canEdit).toBe(true);
  });

  it('sets isAuthorOfCurrentUser=false for other users\' comments', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const theirs = detail!.comments.find(c => c.body === 'Member comment')!;
    expect(theirs.isAuthorOfCurrentUser).toBe(false);
    expect(theirs.canEdit).toBe(false);
  });

  it('sets isAuthorOfCurrentUser=false when widgetUserId is undefined (anonymous)', async () => {
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID);
    for (const c of detail!.comments) {
      expect(c.isAuthorOfCurrentUser).toBe(false);
      expect(c.canEdit).toBe(false);
    }
  });

  it('exposes createdByType and externalUserId on the ticket itself when available', async () => {
    const [extTask] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Widget-authored', visibility: 'public',
      createdByType: 'external', createdById: WIDGET_USER_ID, createdByName: 'Alice',
    }).returning({ id: workspaceTasks.id });
    const detail = await getPublicTicketDetail(PROJECT_ID, extTask!.id, WIDGET_USER_ID);
    expect(detail!.ticket.createdByType).toBe('external');
    expect(detail!.ticket.externalUserId).toBe(EXTERNAL_USER_ID);
    await db.delete(workspaceTasks).where(eq(workspaceTasks.id, extTask!.id));
  });

  it('does not elevate member comments even if createdById collides with current widgetUserId', async () => {
    // Attacker scenario: member-authored comment whose createdById string
    // happens to equal the widget user's id. Guard must block elevation.
    await db.insert(workspaceTaskComments).values({
      serverId: SERVER_ID,
      taskId: TASK_ID,
      content: 'Spoofed member comment',
      createdByType: 'member',
      createdById: WIDGET_USER_ID,  // deliberate collision
      createdByName: 'Impostor',
      updatedAt: new Date(),
    });
    const detail = await getPublicTicketDetail(PROJECT_ID, TASK_ID, WIDGET_USER_ID);
    const spoofed = detail!.comments.find(c => c.body === 'Spoofed member comment')!;
    expect(spoofed.createdByType).toBe('member');
    expect(spoofed.isAuthorOfCurrentUser).toBe(false);
    expect(spoofed.canEdit).toBe(false);
    expect(spoofed.externalUserId).toBeNull();
  });
});
