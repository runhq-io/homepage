/**
 * Integration tests for WorkspaceTaskActivityFeedService.listFeed.
 *
 * Uses the real Neon dev database. Each test run uses a unique SERVER_ID
 * (suffixed with a timestamp + random hex) so test rows are isolated across
 * concurrent or repeated runs and cleanup is scoped to that server only.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  workspaceTasks,
  workspaceTaskActivity,
  workspaceTaskComments,
} from '../../db/schema';
import { listFeed } from './WorkspaceTaskActivityFeedService';

// ---------------------------------------------------------------------------
// Unique identifiers for this test run — must be valid UUIDs and text IDs
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex'); // e.g. "a1b2c3d4e5f6"
const SERVER_ID = `ws_feed_test_${RUN_HEX}`;

// Build valid UUIDs: 8-4-4-4-12 hex chars
const ALICE_ID = `feedfeed-0001-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const BOB_ID   = `feedfeed-0002-4000-a000-${RUN_HEX.padStart(12, '0')}`;

let TASK_ID: string;

// ---------------------------------------------------------------------------
// Seed — runs once before all tests
// ---------------------------------------------------------------------------

async function seed() {
  // Users — only id is truly required (email/username/name all nullable)
  await db
    .insert(users)
    .values([
      { id: ALICE_ID, email: `alice+${RUN_HEX}@test.invalid`, name: 'Alice' },
      { id: BOB_ID,   email: `bob+${RUN_HEX}@test.invalid`,   name: 'Bob' },
    ])
    .onConflictDoNothing();

  // Server — id is text PK, name + ownerId are NOT NULL
  await db
    .insert(servers)
    .values({
      id: SERVER_ID,
      name: `Test Server ${RUN_HEX}`,
      ownerId: ALICE_ID,
    })
    .onConflictDoNothing();

  // One workspace task
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      serverId: SERVER_ID,
      title: `Feed Test Task ${RUN_HEX}`,
      // status, visibility, sourceType, createdByType, commentsDisabled all have defaults
    })
    .returning({ id: workspaceTasks.id });

  if (!task) throw new Error('Failed to insert workspace task');
  TASK_ID = task.id;

  // 4 activity rows — spread across time so sort order is deterministic
  const base = Date.now() - 5000;
  await db
    .insert(workspaceTaskActivity)
    .values([
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        type: 'task_created',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: new Date(base),
      },
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        type: 'status_change',
        metadata: { from: 'pending', to: 'in_progress' },
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: new Date(base + 1000),
      },
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        type: 'status_change',
        metadata: { from: 'in_progress', to: 'done' },
        createdById: BOB_ID,
        createdByName: 'Bob',
        createdAt: new Date(base + 2000),
      },
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        type: 'agent_assigned',
        createdById: BOB_ID,
        createdByName: 'Bob',
        createdAt: new Date(base + 3000),
      },
    ])
    .onConflictDoNothing();

  // 2 comment rows
  await db
    .insert(workspaceTaskComments)
    .values([
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        content: 'First comment from Alice',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: new Date(base + 500),
      },
      {
        serverId: SERVER_ID,
        taskId: TASK_ID,
        content: 'Second comment from Bob',
        createdById: BOB_ID,
        createdByName: 'Bob',
        createdAt: new Date(base + 2500),
      },
    ])
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  // Delete child rows first (activity + comments cascade from workspace_tasks,
  // workspace_tasks reference servers, servers reference users).
  await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, SERVER_ID));
  await db.delete(workspaceTaskComments).where(eq(workspaceTaskComments.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, ALICE_ID));
  await db.delete(users).where(eq(users.id, BOB_ID));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceTaskActivityFeedService.listFeed', () => {
  it('returns activity + comments merged DESC by created_at with correct total', async () => {
    const result = await listFeed(SERVER_ID, { limit: 20, offset: 0 });

    // 4 activity + 2 comments = 6 total
    expect(result.total).toBe(6);
    expect(result.entries.length).toBe(6);

    // Verify descending order
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1].createdAt).toBeGreaterThanOrEqual(result.entries[i].createdAt);
    }

    // Each entry must have required shape
    for (const e of result.entries) {
      expect(e.id).toBeTruthy();
      expect(e.todoId).toBeTruthy();
      expect(typeof e.type).toBe('string');
      expect(typeof e.createdAt).toBe('number');
      expect(e.attachments).toBeNull();
    }

    // Comments must surface as type 'comment'
    const commentEntries = result.entries.filter((e) => e.type === 'comment');
    expect(commentEntries.length).toBe(2);
  });

  it('filters by userId', async () => {
    const result = await listFeed(SERVER_ID, { userId: ALICE_ID, limit: 20, offset: 0 });

    // Alice has: task_created, status_change(→in_progress), comment#1 = 3 rows
    expect(result.total).toBe(3);
    for (const e of result.entries) {
      expect(e.createdBy).toBe(ALICE_ID);
    }
  });

  it('filters by type (activity types only; no comments)', async () => {
    const result = await listFeed(SERVER_ID, { type: 'status_change', limit: 20, offset: 0 });

    // 2 status_change rows, 0 comments
    expect(result.total).toBe(2);
    for (const e of result.entries) {
      expect(e.type).toBe('status_change');
    }
  });

  it('filters by type=comment (only surfaces comment rows)', async () => {
    const result = await listFeed(SERVER_ID, { type: 'comment', limit: 20, offset: 0 });

    expect(result.total).toBe(2);
    for (const e of result.entries) {
      expect(e.type).toBe('comment');
    }
  });

  it('paginates correctly using limit/offset on the merged ordering', async () => {
    const page1 = await listFeed(SERVER_ID, { limit: 2, offset: 0 });
    const page2 = await listFeed(SERVER_ID, { limit: 2, offset: 2 });
    const page3 = await listFeed(SERVER_ID, { limit: 2, offset: 4 });

    // Each page returns at most 2 entries; total is always 6
    expect(page1.total).toBe(6);
    expect(page1.entries.length).toBe(2);
    expect(page2.entries.length).toBe(2);
    expect(page3.entries.length).toBe(2);

    // No overlap: all IDs should be distinct across pages
    const allIds = [
      ...page1.entries.map((e) => e.id),
      ...page2.entries.map((e) => e.id),
      ...page3.entries.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBe(6);

    // Page1 entries must be newer than page2 entries (DESC order)
    const minPage1 = Math.min(...page1.entries.map((e) => e.createdAt));
    const maxPage2 = Math.max(...page2.entries.map((e) => e.createdAt));
    expect(minPage1).toBeGreaterThanOrEqual(maxPage2);
  });
});
