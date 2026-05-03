import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  workspaceTasks,
  workspaceTaskVotes,
  widgetProjects,
  widgetUsers,
} from '../../db/schema';
import { castVote, retractVote } from './WidgetService';

const RUN_HEX = randomBytes(6).toString('hex');

const SERVER_A = `ws_vote_a_${RUN_HEX}`;
const SERVER_B = `ws_vote_b_${RUN_HEX}`;
const USER_A = `00000000-00a0-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const USER_B = `00000000-00b0-4000-a000-${RUN_HEX.padStart(12, '0')}`;

let PROJECT_A_ID: string;
let PROJECT_B_ID: string;
let WIDGET_USER_A_ID: string;
let WIDGET_USER_B_ID: string;
let TASK_A_ID: string;
let TASK_B_ID: string;

beforeAll(async () => {
  await db.insert(users).values([
    { id: USER_A, email: `va+${RUN_HEX}@test.invalid`, name: 'A' },
    { id: USER_B, email: `vb+${RUN_HEX}@test.invalid`, name: 'B' },
  ]).onConflictDoNothing();

  await db.insert(servers).values([
    { id: SERVER_A, name: `Srv A ${RUN_HEX}`, ownerId: USER_A },
    { id: SERVER_B, name: `Srv B ${RUN_HEX}`, ownerId: USER_B },
  ]).onConflictDoNothing();

  const projects = await db.insert(widgetProjects).values([
    {
      serverId: SERVER_A,
      name: `Vote A ${RUN_HEX}`,
      slug: `vote-a-${RUN_HEX}`,
      apiKey: `apikey-a-${RUN_HEX}`,
      apiSecretHash: `secret-a-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    },
    {
      serverId: SERVER_B,
      name: `Vote B ${RUN_HEX}`,
      slug: `vote-b-${RUN_HEX}`,
      apiKey: `apikey-b-${RUN_HEX}`,
      apiSecretHash: `secret-b-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    },
  ]).returning({ id: widgetProjects.id, serverId: widgetProjects.serverId });
  PROJECT_A_ID = projects.find((p) => p.serverId === SERVER_A)!.id;
  PROJECT_B_ID = projects.find((p) => p.serverId === SERVER_B)!.id;

  const wus = await db.insert(widgetUsers).values([
    { projectId: PROJECT_A_ID, externalUserId: `ext-a-${RUN_HEX}`, name: 'Voter A' },
    { projectId: PROJECT_B_ID, externalUserId: `ext-b-${RUN_HEX}`, name: 'Voter B' },
  ]).returning({ id: widgetUsers.id, projectId: widgetUsers.projectId });
  WIDGET_USER_A_ID = wus.find((w) => w.projectId === PROJECT_A_ID)!.id;
  WIDGET_USER_B_ID = wus.find((w) => w.projectId === PROJECT_B_ID)!.id;

  const tasks = await db.insert(workspaceTasks).values([
    {
      serverId: SERVER_A,
      title: 'Task A (approved, votable)',
      visibility: 'public',
      moderationStatus: 'approved',
    },
    {
      serverId: SERVER_B,
      title: 'Task B (approved, votable)',
      visibility: 'public',
      moderationStatus: 'approved',
    },
  ]).returning({ id: workspaceTasks.id, serverId: workspaceTasks.serverId });
  TASK_A_ID = tasks.find((t) => t.serverId === SERVER_A)!.id;
  TASK_B_ID = tasks.find((t) => t.serverId === SERVER_B)!.id;
});

afterAll(async () => {
  await db.delete(workspaceTaskVotes).where(inArray(workspaceTaskVotes.serverId, [SERVER_A, SERVER_B]));
  await db.delete(workspaceTasks).where(inArray(workspaceTasks.serverId, [SERVER_A, SERVER_B]));
  await db.delete(widgetUsers).where(inArray(widgetUsers.projectId, [PROJECT_A_ID, PROJECT_B_ID]));
  await db.delete(widgetProjects).where(inArray(widgetProjects.id, [PROJECT_A_ID, PROJECT_B_ID]));
  await db.delete(servers).where(inArray(servers.id, [SERVER_A, SERVER_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
});

describe('castVote', () => {
  it('records a vote when the ticket belongs to the caller’s project', async () => {
    await castVote(PROJECT_A_ID, TASK_A_ID, WIDGET_USER_A_ID, true);
    const [vote] = await db
      .select()
      .from(workspaceTaskVotes)
      .where(eq(workspaceTaskVotes.taskId, TASK_A_ID));
    expect(vote).toBeDefined();
    expect(vote.voterId).toBe(WIDGET_USER_A_ID);
    expect(vote.value).toBe(true);
    expect(vote.serverId).toBe(SERVER_A);
  });

  it('rejects cross-tenant votes (Project A user on Project B ticket)', async () => {
    await expect(
      castVote(PROJECT_A_ID, TASK_B_ID, WIDGET_USER_A_ID, true)
    ).rejects.toThrow('Ticket not found');

    const votes = await db
      .select()
      .from(workspaceTaskVotes)
      .where(eq(workspaceTaskVotes.taskId, TASK_B_ID));
    expect(votes).toHaveLength(0);
  });

  it('throws Ticket not found when ticketId does not exist at all', async () => {
    await expect(
      castVote(PROJECT_A_ID, '00000000-0000-0000-0000-000000000000', WIDGET_USER_A_ID, true)
    ).rejects.toThrow('Ticket not found');
  });
});

describe('retractVote', () => {
  it('removes a vote when the ticket belongs to the caller’s project', async () => {
    await castVote(PROJECT_B_ID, TASK_B_ID, WIDGET_USER_B_ID, true);
    await retractVote(PROJECT_B_ID, TASK_B_ID, WIDGET_USER_B_ID);
    const votes = await db
      .select()
      .from(workspaceTaskVotes)
      .where(eq(workspaceTaskVotes.taskId, TASK_B_ID));
    expect(votes).toHaveLength(0);
  });

  it('rejects cross-tenant retractions and leaves the original vote intact', async () => {
    await castVote(PROJECT_B_ID, TASK_B_ID, WIDGET_USER_B_ID, true);

    await expect(
      retractVote(PROJECT_A_ID, TASK_B_ID, WIDGET_USER_A_ID)
    ).rejects.toThrow('Ticket not found');

    const votes = await db
      .select()
      .from(workspaceTaskVotes)
      .where(eq(workspaceTaskVotes.taskId, TASK_B_ID));
    expect(votes).toHaveLength(1);
    expect(votes[0].voterId).toBe(WIDGET_USER_B_ID);
  });
});
