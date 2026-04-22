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
import { listFeed, countNew, memberStats, memberActivity } from './WorkspaceTaskActivityFeedService';

// ---------------------------------------------------------------------------
// Unique identifiers for this test run — must be valid UUIDs and text IDs
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex'); // e.g. "a1b2c3d4e5f6"
const SERVER_ID = `ws_feed_test_${RUN_HEX}`;

// Build valid UUIDs: 8-4-4-4-12 hex chars
const ALICE_ID = `feedfeed-0001-4000-a000-${RUN_HEX.padStart(12, '0')}`;
const BOB_ID   = `feedfeed-0002-4000-a000-${RUN_HEX.padStart(12, '0')}`;

let TASK_ID: string;
let seedBase: number; // captured from seed so countNew tests can split on it

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
  seedBase = base; // expose to tests for boundary assertions
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

describe('WorkspaceTaskActivityFeedService.countNew', () => {
  it('counts activity+comment rows strictly newer than since', async () => {
    // Seed layout (relative to seedBase = Date.now() - 5000 at seed time):
    //   activity @ seedBase+0, +1000, +2000, +3000
    //   comments @ seedBase+500, +2500
    //
    // Picking since = seedBase + 1500 splits the seed at a real boundary:
    //   rows BEFORE (or equal): +0, +500, +1000   (3 rows — not counted)
    //   rows AFTER:             +2000, +2500, +3000 (3 rows — counted)
    // Expected count = 3, which is neither 0 nor the total (6).
    const since = seedBase + 1500;
    const count = await countNew(SERVER_ID, since);
    expect(count).toBe(3);
  });

  it('returns 0 when since is in the future', async () => {
    const count = await countNew(SERVER_ID, Date.now() + 10_000_000);
    expect(count).toBe(0);
  });
});

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

// ---------------------------------------------------------------------------
// memberStats tests
// ---------------------------------------------------------------------------
//
// Seed recap (all rows use seedBase = Date.now() - 5000 captured in beforeAll):
//   Activity rows:
//     base+0     Alice  task_created
//     base+1000  Alice  status_change  { from: 'pending',      to: 'in_progress' }
//     base+2000  Bob    status_change  { from: 'in_progress',  to: 'done'        }
//     base+3000  Bob    agent_assigned
//   Comment rows:
//     base+500   Alice  'First comment from Alice'
//     base+2500  Bob    'Second comment from Bob'
//
// Per-member expected (full window):
//   Alice: tasksCreated=1, tasksCompleted=0, agentsAssigned=0, comments=1
//   Bob:   tasksCreated=0, tasksCompleted=1, agentsAssigned=1, comments=1

describe('WorkspaceTaskActivityFeedService.memberStats', () => {
  it('aggregates per-member stats across the full seed (no date window)', async () => {
    const stats = await memberStats(SERVER_ID);

    // Both Alice and Bob must appear
    const alice = stats.find((s) => s.userId === ALICE_ID);
    const bob   = stats.find((s) => s.userId === BOB_ID);

    expect(alice).toBeDefined();
    expect(bob).toBeDefined();

    // Alice: task_created activity + status_change→in_progress + 1 comment
    expect(alice!.userName).toBe('Alice');
    expect(alice!.isAgent).toBe(false);
    expect(alice!.tasksCreated).toBe(1);
    expect(alice!.tasksCompleted).toBe(0);
    expect(alice!.agentsAssigned).toBe(0);
    expect(alice!.comments).toBe(1);

    // Bob: status_change→done + agent_assigned + 1 comment
    expect(bob!.userName).toBe('Bob');
    expect(bob!.isAgent).toBe(false);
    expect(bob!.tasksCreated).toBe(0);
    expect(bob!.tasksCompleted).toBe(1);
    expect(bob!.agentsAssigned).toBe(1);
    expect(bob!.comments).toBe(1);
  });

  it('respects startMs/endMs date window', async () => {
    // Window [base+1500, base+2000]: lte is inclusive, so endMs = base+2000 captures
    // Bob's status_change→done at exactly base+2000 while excluding his comment at
    // base+2500 and Bob's agent_assigned at base+3000.
    // Alice's rows are all outside: +0, +1000 (before window), +500 comment (before window)
    const startMs = seedBase + 1500;
    const endMs   = seedBase + 2000; // inclusive — captures Bob's status_change→done exactly

    const stats = await memberStats(SERVER_ID, startMs, endMs);

    // Only Bob should appear (only his status_change→done falls in the window)
    expect(stats.length).toBe(1);

    const bob = stats.find((s) => s.userId === BOB_ID);
    expect(bob).toBeDefined();
    expect(bob!.tasksCompleted).toBe(1);
    expect(bob!.tasksCreated).toBe(0);
    expect(bob!.agentsAssigned).toBe(0);
    expect(bob!.comments).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memberActivity tests
// ---------------------------------------------------------------------------
//
// Seed recap (all rows use seedBase = Date.now() - 5000 captured in beforeAll):
//   Activity rows:
//     base+0     Alice  task_created
//     base+500   Alice  comment (workspace_task_comments)
//     base+1000  Alice  status_change  { from: 'pending', to: 'in_progress' }
//     base+2000  Bob    status_change  { from: 'in_progress', to: 'done' }
//     base+2500  Bob    comment (workspace_task_comments)
//     base+3000  Bob    agent_assigned
//
// All 6 rows fall within the same UTC calendar day (today).
//
// Day-bucket expected:
//   Alice: created=1, completed=0, assigned=0, comments=1, total=2
//   Bob:   created=0, completed=1, assigned=1, comments=1, total=3

describe('WorkspaceTaskActivityFeedService.memberActivity', () => {
  it('returns day-bucketed per-member totals for today with correct counts', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // Wide window: 10s before base to 60s after, capturing all 6 seed rows
    const startMs = seedBase - 10_000;
    const endMs   = seedBase + 60_000;

    const result = await memberActivity(SERVER_ID, startMs, endMs, 'day');

    expect(result.buckets).toBeDefined();
    expect(Array.isArray(result.buckets)).toBe(true);

    // There must be a bucket for today
    const todayBucket = result.buckets.find((b) => b.period.startsWith(today));
    expect(todayBucket).toBeDefined();

    const alice = todayBucket!.members.find((m) => m.userId === ALICE_ID);
    const bob   = todayBucket!.members.find((m) => m.userId === BOB_ID);

    // Both members must appear
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();

    // Alice: task_created + status_change→in_progress (NOT done) + comment
    expect(alice!.userName).toBe('Alice');
    expect(alice!.isAgent).toBe(false);
    expect(alice!.created).toBe(1);
    expect(alice!.completed).toBe(0);
    expect(alice!.assigned).toBe(0);
    expect(alice!.comments).toBe(1);
    expect(alice!.total).toBe(2);

    // Bob: status_change→done + agent_assigned + comment
    expect(bob!.userName).toBe('Bob');
    expect(bob!.isAgent).toBe(false);
    expect(bob!.created).toBe(0);
    expect(bob!.completed).toBe(1);
    expect(bob!.assigned).toBe(1);
    expect(bob!.comments).toBe(1);
    expect(bob!.total).toBe(3);
  });
});
