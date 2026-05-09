/**
 * Service-level tests for assignAgent and suggestAssignment.
 *
 * These tests exercise the real DB query path to verify the cross-tenant guard:
 * a ticket that exists on Server B must NOT be accessible when the calling
 * widget project belongs to Server A.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  workspaceTasks,
  widgetProjects,
  widgetExposedAgents,
} from '../../db/schema';
import { assignAgent, suggestAssignment, WidgetAssignError } from './WidgetService';

// ---------------------------------------------------------------------------
// Mock external I/O — ServerService is never reached in the cross-tenant case
// because the ticket lookup fails first. We mock it anyway so that the happy-
// path (same-server) tests can also be added here without network calls.
// ---------------------------------------------------------------------------
vi.mock('./ServerService', () => ({
  serverTokenFetch: vi.fn(),
}));

vi.mock('./WorkspaceTaskService', () => ({
  getTaskById: vi.fn(),
  addComment: vi.fn(),
}));

const RUN_HEX = randomBytes(6).toString('hex');

const USER_A = `00000000-aa00-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const USER_B = `00000000-bb00-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const SERVER_A = `ws_assign_a_${RUN_HEX}`;
const SERVER_B = `ws_assign_b_${RUN_HEX}`;

let PROJECT_A_ID: string;
let PROJECT_B_ID: string;
let TASK_A_ID: string; // widget ticket on Server A
let TASK_B_ID: string; // widget ticket on Server B

beforeAll(async () => {
  await db
    .insert(users)
    .values([
      { id: USER_A, email: `asgn_a+${RUN_HEX}@test.invalid`, name: 'A' },
      { id: USER_B, email: `asgn_b+${RUN_HEX}@test.invalid`, name: 'B' },
    ])
    .onConflictDoNothing();

  await db
    .insert(servers)
    .values([
      { id: SERVER_A, name: `AssignSrv A ${RUN_HEX}`, ownerId: USER_A },
      { id: SERVER_B, name: `AssignSrv B ${RUN_HEX}`, ownerId: USER_B },
    ])
    .onConflictDoNothing();

  const projects = await db
    .insert(widgetProjects)
    .values([
      {
        serverId: SERVER_A,
        name: `Assign A ${RUN_HEX}`,
        slug: `assign-a-${RUN_HEX}`,
        apiKey: `apikey-asgn-a-${RUN_HEX}`,
        apiSecretHash: `secret-asgn-a-${RUN_HEX}`,
        enabled: true,
        isPublic: true,
        widgetAgentAssignmentEnabled: true,
        widgetAssignRoles: ['triager'],
        widgetRoleClaimName: 'runhq_roles',
      },
      {
        serverId: SERVER_B,
        name: `Assign B ${RUN_HEX}`,
        slug: `assign-b-${RUN_HEX}`,
        apiKey: `apikey-asgn-b-${RUN_HEX}`,
        apiSecretHash: `secret-asgn-b-${RUN_HEX}`,
        enabled: true,
        isPublic: true,
        widgetAgentAssignmentEnabled: true,
        widgetAssignRoles: ['triager'],
        widgetRoleClaimName: 'runhq_roles',
      },
    ])
    .returning({ id: widgetProjects.id, serverId: widgetProjects.serverId });

  PROJECT_A_ID = projects.find((p) => p.serverId === SERVER_A)!.id;
  PROJECT_B_ID = projects.find((p) => p.serverId === SERVER_B)!.id;

  const tasks = await db
    .insert(workspaceTasks)
    .values([
      {
        serverId: SERVER_A,
        title: 'Widget Ticket A',
        visibility: 'public',
        sourceType: 'widget',
        createdByType: 'external',
      },
      {
        serverId: SERVER_B,
        title: 'Widget Ticket B',
        visibility: 'public',
        sourceType: 'widget',
        createdByType: 'external',
      },
    ])
    .returning({ id: workspaceTasks.id, serverId: workspaceTasks.serverId });

  TASK_A_ID = tasks.find((t) => t.serverId === SERVER_A)!.id;
  TASK_B_ID = tasks.find((t) => t.serverId === SERVER_B)!.id;

  // Expose an agent on Project A so suggestAssignment can reach the server
  // query (exposed.length > 0 guard) in the happy-path scenario.
  await db
    .insert(widgetExposedAgents)
    .values({
      widgetProjectId: PROJECT_A_ID,
      agentId: 'agent-exposed-a',
      agentName: 'Agent A',
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(widgetExposedAgents)
    .where(inArray(widgetExposedAgents.widgetProjectId, [PROJECT_A_ID, PROJECT_B_ID]));
  await db.delete(workspaceTasks).where(inArray(workspaceTasks.serverId, [SERVER_A, SERVER_B]));
  await db.delete(widgetProjects).where(inArray(widgetProjects.id, [PROJECT_A_ID, PROJECT_B_ID]));
  await db.delete(servers).where(inArray(servers.id, [SERVER_A, SERVER_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
});

// ---------------------------------------------------------------------------
// assignAgent — cross-tenant guard
// ---------------------------------------------------------------------------

describe('assignAgent — cross-tenant guard', () => {
  const VALID_REQ = {
    agentId: 'agent-exposed-a',
    command: 'Handle this',
    actor: {
      widgetUserId: 'wu-test',
      externalUserId: 'ext-test',
      name: 'Triager',
      matchedRoles: ['triager'],
    },
  };

  it('throws ticket_not_found (404) when ticket exists on a different server than the calling project', async () => {
    // Project A is on Server A; TASK_B_ID lives on Server B → cross-tenant
    await expect(assignAgent(PROJECT_A_ID, TASK_B_ID, VALID_REQ)).rejects.toMatchObject({
      name: 'WidgetAssignError',
      code: 'ticket_not_found',
      status: 404,
    });
  });

  it('throws project_not_found (404) when the widget project does not exist', async () => {
    await expect(
      assignAgent('00000000-0000-0000-0000-000000000000', TASK_A_ID, VALID_REQ),
    ).rejects.toMatchObject({
      name: 'WidgetAssignError',
      code: 'project_not_found',
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// suggestAssignment — cross-tenant guard
// ---------------------------------------------------------------------------

describe('suggestAssignment — cross-tenant guard', () => {
  it('returns { agentId: null, command: "" } when ticket exists on a different server than the calling project', async () => {
    // Project A is on Server A; TASK_B_ID lives on Server B → cross-tenant
    const result = await suggestAssignment(PROJECT_A_ID, TASK_B_ID);
    expect(result).toEqual({ agentId: null, command: '' });
  });

  it('returns { agentId: null, command: "" } when the widget project does not exist', async () => {
    const result = await suggestAssignment('00000000-0000-0000-0000-000000000000', TASK_A_ID);
    expect(result).toEqual({ agentId: null, command: '' });
  });
});
