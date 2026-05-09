import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import { users, servers, workspaceTasks, workspaceTaskComments, workspaceTaskActivity, widgetProjects, widgetUsers } from '../../db/schema';
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
  await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, SERVER_ID));
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
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

  it('does not leak externalUserId across widget projects', async () => {
    // Two widget projects on different servers. A task we insert on SERVER_B
    // carries a comment whose createdById points at project A's widgetUser.
    // (Cross-project ID collision is the leak scenario.) Viewing via project B
    // must not resolve that id to project A's externalUserId.
    const SERVER_B = `ws_td_b_${RUN_HEX}`;
    await db.insert(servers).values({ id: SERVER_B, name: `SrvB ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
    const [projectB] = await db.insert(widgetProjects).values({
      serverId: SERVER_B,
      name: `Detail Test B ${RUN_HEX}`,
      slug: `detail-test-b-${RUN_HEX}`,
      apiKey: `apikey-b-${RUN_HEX}`,
      apiSecretHash: `secret-b-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    }).returning({ id: widgetProjects.id });

    try {
      const [taskB] = await db.insert(workspaceTasks).values({
        serverId: SERVER_B, title: 'Cross-project task', visibility: 'public', status: 'in_progress',
      }).returning({ id: workspaceTasks.id });

      // Comment whose createdById references project A's widget user.
      await db.insert(workspaceTaskComments).values({
        serverId: SERVER_B,
        taskId: taskB!.id,
        content: 'Cross-project external comment',
        createdByType: 'external',
        createdById: WIDGET_USER_ID, // project A's widget user
        createdByName: 'Alice',
        updatedAt: new Date(),
      });

      const detail = await getPublicTicketDetail(projectB!.id, taskB!.id);
      expect(detail).not.toBeNull();
      const external = detail!.comments.find(c => c.body === 'Cross-project external comment')!;
      // createdByType is still external (sourced from the comment row), but
      // the externalUserId must NOT be leaked to project B's viewer.
      expect(external.createdByType).toBe('external');
      expect(external.externalUserId).toBeNull();
    } finally {
      await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_B));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_B));
      await db.delete(widgetProjects).where(eq(widgetProjects.id, projectB!.id));
      await db.delete(servers).where(eq(servers.id, SERVER_B));
    }
  });

  it('exposes commentsDisabled on the ticket detail payload', async () => {
    const [disabled] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Has flag', visibility: 'public',
      createdByType: 'external', createdById: WIDGET_USER_ID, commentsDisabled: true,
    }).returning({ id: workspaceTasks.id });
    const detail = await getPublicTicketDetail(PROJECT_ID, disabled!.id, WIDGET_USER_ID);
    expect(detail!.ticket.commentsDisabled).toBe(true);
    await db.delete(workspaceTasks).where(eq(workspaceTasks.id, disabled!.id));
  });

  it('returns assignedAgentName + lastTriager from latest agent_assigned activity', async () => {
    // Insert an agent_assigned activity by an external user (triager scenario)
    const [extTask] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Assign agent test', visibility: 'public',
    }).returning({ id: workspaceTasks.id });

    await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID,
      taskId: extTask!.id,
      type: 'agent_assigned',
      createdByType: 'external',
      createdByName: 'Alice',
      metadata: { agentName: 'TestBot' },
    });

    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, extTask!.id);
      expect(detail?.ticket.assignedAgentName).toBe('TestBot');
      expect(detail?.ticket.lastTriager?.name).toBe('Alice');
      expect(detail?.ticket.lastTriager?.at).toBeTruthy();
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, extTask!.id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, extTask!.id));
    }
  });

  it('returns null lastTriager when latest assignment was done by an internal actor', async () => {
    // Insert an agent_assigned activity by a member (not external)
    const [intTask] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID, title: 'Internal assign test', visibility: 'public',
    }).returning({ id: workspaceTasks.id });

    await db.insert(workspaceTaskActivity).values({
      serverId: SERVER_ID,
      taskId: intTask!.id,
      type: 'agent_assigned',
      createdByType: 'member',
      createdByName: 'Admin',
      metadata: { agentName: 'TestBot' },
    });

    try {
      const detail = await getPublicTicketDetail(PROJECT_ID, intTask!.id);
      expect(detail?.ticket.assignedAgentName).toBe('TestBot');
      expect(detail?.ticket.lastTriager).toBeNull();
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.taskId, intTask!.id));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.id, intTask!.id));
    }
  });

  it('channel-scoped widget project cannot resolve a task outside its channel by id', async () => {
    // Project with a channel scope set cannot fetch details for a ticket
    // whose workspaceChannelId differs (or is null).
    const SERVER_C = `ws_td_c_${RUN_HEX}`;
    await db.insert(servers).values({ id: SERVER_C, name: `SrvC ${RUN_HEX}`, ownerId: USER_ID }).onConflictDoNothing();
    const [scoped] = await db.insert(widgetProjects).values({
      serverId: SERVER_C,
      name: `Scoped ${RUN_HEX}`,
      slug: `scoped-${RUN_HEX}`,
      apiKey: `apikey-scoped-${RUN_HEX}`,
      apiSecretHash: `secret-scoped-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
      channelId: `ch-a-${RUN_HEX}`,
    }).returning({ id: widgetProjects.id });

    try {
      // Task with no workspaceChannelId — scoped widget must not see it.
      const [unscopedTask] = await db.insert(workspaceTasks).values({
        serverId: SERVER_C, title: 'Unscoped', visibility: 'public',
      }).returning({ id: workspaceTasks.id });
      const detail = await getPublicTicketDetail(scoped!.id, unscopedTask!.id);
      expect(detail).toBeNull();
    } finally {
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_C));
      await db.delete(widgetProjects).where(eq(widgetProjects.id, scoped!.id));
      await db.delete(servers).where(eq(servers.id, SERVER_C));
    }
  });
});
