/**
 * Integration tests: status update → community awarding hook in WorkspaceTaskService.
 *
 * Real Neon DB via .env DATABASE_URL.
 * Structural fixtures (user, server, widgetProject, widgetUser, workspace task) are
 * created once in beforeAll and reused. Community rows (pointGrants, widgetUserBalances,
 * widgetUserNotifications, workspaceTasks) are reset between each test.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  workspaceTasks,
  workspaceTaskVotes,
  pointGrants,
  widgetUserBalances,
  widgetUserNotifications,
} from '../../db/schema';
import { updateTask } from './WorkspaceTaskService';

// ---------------------------------------------------------------------------
// Unique run ID to prevent cross-test pollution in shared DB
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `wt_award_test_${RUN_HEX}`;
const CHANNEL_ID = `chan_${RUN_HEX}`;
const USER_ID = `00000000-9999-4000-a000-${RUN_HEX.padStart(12, '0')}`;

let PROJECT_ID: string;
let WIDGET_USER_ID: string;
let EXTERNAL_USER_ID: string;

// ---------------------------------------------------------------------------
// One-time structural setup
// ---------------------------------------------------------------------------
beforeAll(async () => {
  EXTERNAL_USER_ID = `ext-${RUN_HEX}`;

  await db.insert(users).values({
    id: USER_ID,
    email: `wt_award+${RUN_HEX}@test.invalid`,
    name: 'WTA Test',
  }).onConflictDoNothing();

  await db.insert(servers).values({
    id: SERVER_ID,
    name: `WTA Server ${RUN_HEX}`,
    ownerId: USER_ID,
  }).onConflictDoNothing();

  const [project] = await db.insert(widgetProjects).values({
    serverId: SERVER_ID,
    name: `WTA Project ${RUN_HEX}`,
    slug: `wta-${RUN_HEX}`,
    apiKey: `wta-apikey-${RUN_HEX}`,
    apiSecretHash: `wta-secret-${RUN_HEX}`,
    enabled: true,
    isPublic: true,
    channelId: CHANNEL_ID,
  }).returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: EXTERNAL_USER_ID,
    name: 'Widget Alice',
  }).returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;
});

// ---------------------------------------------------------------------------
// Per-test community row cleanup
// ---------------------------------------------------------------------------
beforeEach(async () => {
  // Clean up in FK-safe order: notifications → balances → grants
  await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, PROJECT_ID));
  await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, PROJECT_ID));
  await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_ID));
  // Remove any tasks from this run (votes cascade-delete)
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
});

// ---------------------------------------------------------------------------
// Structural teardown
// ---------------------------------------------------------------------------
afterAll(async () => {
  await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, PROJECT_ID));
  await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, PROJECT_ID));
  await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a widget task belonging to WIDGET_USER_ID (default status 'planned'). */
async function insertWidgetTask(overrides: {
  status?: string;
  sourceType?: 'widget' | 'workspace';
} = {}): Promise<string> {
  const [task] = await db.insert(workspaceTasks).values({
    serverId: SERVER_ID,
    workspaceChannelId: CHANNEL_ID,
    title: `Test Task ${randomBytes(4).toString('hex')}`,
    status: (overrides.status ?? 'planned') as any,
    sourceType: overrides.sourceType ?? 'widget',
    createdByType: overrides.sourceType === 'workspace' ? 'member' : 'external',
    createdById: overrides.sourceType === 'workspace' ? null : WIDGET_USER_ID,
    createdByName: 'Widget Alice',
    visibility: 'public',
  }).returning({ id: workspaceTasks.id });
  return task!.id;
}

/** Creates an additional widget user in the project (usable as an external voter). */
async function createWidgetUser(label: string): Promise<string> {
  const [wu] = await db.insert(widgetUsers).values({
    projectId: PROJECT_ID,
    externalUserId: `ext-${label}-${randomBytes(3).toString('hex')}`,
    name: label,
  }).returning({ id: widgetUsers.id });
  return wu!.id;
}

/** Records an external up-vote by widgetUserId on the task. */
async function addExternalVote(taskId: string, widgetUserId: string): Promise<void> {
  await db.insert(workspaceTaskVotes).values({
    serverId: SERVER_ID,
    taskId,
    voterId: widgetUserId,
    voterType: 'external',
    value: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('status update triggers community step-coin awarding', () => {
  it('grants creator + external voter 1 coin per crossed tier', async () => {
    const taskId = await insertWidgetTask({ status: 'planned' });
    const voterId = await createWidgetUser('Voter');
    await addExternalVote(taskId, voterId);

    const updated = await updateTask(SERVER_ID, taskId, { status: 'reviewed' });
    expect(updated.task!.status).toBe('reviewed');

    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    // 2 crossed tiers (in_progress, reviewed) x 2 recipients (creator, voter) = 4
    expect(grants).toHaveLength(4);
    expect(grants.every((g) => g.source === 'step_advance' && g.amount === 1)).toBe(true);

    const creatorGrants = grants.filter((g) => g.widgetUserId === WIDGET_USER_ID);
    const voterGrants = grants.filter((g) => g.widgetUserId === voterId);
    expect(creatorGrants).toHaveLength(2);
    expect(voterGrants).toHaveLength(2);
    expect(creatorGrants.every((g) => g.reasonCode === 'creator_step')).toBe(true);
    expect(voterGrants.every((g) => g.reasonCode === 'voter_step')).toBe(true);
  });

  it('treats a jump to done as crossing in_progress + reviewed', async () => {
    const taskId = await insertWidgetTask({ status: 'planned' });
    await updateTask(SERVER_ID, taskId, { status: 'done' });
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(2); // creator only, tiers in_progress + reviewed
  });

  it('does NOT award on a native (workspace) ticket', async () => {
    const taskId = await insertWidgetTask({ status: 'planned', sourceType: 'workspace' });
    await updateTask(SERVER_ID, taskId, { status: 'deployed' });
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(0);
  });

  it('does NOT award when status does not change (no-op update)', async () => {
    const taskId = await insertWidgetTask({ status: 'in_progress' });
    await updateTask(SERVER_ID, taskId, { title: 'New title' });
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(0);
  });

  it('does NOT award on a backward transition', async () => {
    const taskId = await insertWidgetTask({ status: 'merged' });
    await updateTask(SERVER_ID, taskId, { status: 'in_progress' });
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(0);
  });

  it('does NOT re-award a tier when status flaps (idempotency)', async () => {
    const taskId = await insertWidgetTask({ status: 'planned' });
    await updateTask(SERVER_ID, taskId, { status: 'merged' });   // in_progress, reviewed, merged
    await updateTask(SERVER_ID, taskId, { status: 'planned' });  // backward — nothing
    await updateTask(SERVER_ID, taskId, { status: 'merged' });   // re-cross — idempotent
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    // Exactly the 3 distinct tiers, once each (creator only)
    expect(grants).toHaveLength(3);
  });

  it('awards each further tier exactly once as the ticket advances step by step', async () => {
    const taskId = await insertWidgetTask({ status: 'planned' });
    await updateTask(SERVER_ID, taskId, { status: 'in_progress' }); // +1
    await updateTask(SERVER_ID, taskId, { status: 'reviewed' });    // +1
    await updateTask(SERVER_ID, taskId, { status: 'merged' });      // +1
    await updateTask(SERVER_ID, taskId, { status: 'deployed' });    // +1
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(4); // creator, one per tier, no duplicates
  });

  it('updates workspace_task.status even if the creator link is missing (best-effort)', async () => {
    const fakeWidgetUserId = '00000000-dead-4000-beef-000000000000';
    const [task] = await db.insert(workspaceTasks).values({
      serverId: SERVER_ID,
      workspaceChannelId: CHANNEL_ID,
      title: `Orphan Task ${RUN_HEX}`,
      status: 'planned',
      sourceType: 'widget',
      createdByType: 'external',
      createdById: fakeWidgetUserId, // no matching widgetUsers row
      visibility: 'public',
    }).returning({ id: workspaceTasks.id });
    const taskId = task!.id;

    const result = await updateTask(SERVER_ID, taskId, { status: 'deployed' });
    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('deployed');

    // No creator recipient and no voters → no grants, but the status write succeeded.
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.ticketId, taskId));
    expect(grants).toHaveLength(0);
  });
});
