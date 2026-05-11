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
  widgetProjects,
  widgetUsers,
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
      expect(e.canonicalTaskId).toBe(TASK_ID);
      expect(e.todoTitle).toMatch(/Feed Test Task/);
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

  it('deduplicates a user who appears with two different createdByName values', async () => {
    // Simulate a user rename: insert two activity rows for ALICE_ID with different
    // createdByName values. memberStats must return exactly ONE row for ALICE_ID,
    // with userName equal to the lexicographic max of the two names.
    const RENAME_SERVER = `ws_rename_stat_${RUN_HEX}`;

    // Reuse the existing task from the main seed; we need a server + task pair.
    // Use a dedicated server so cleanup is trivial.
    await db
      .insert(servers)
      .values({ id: RENAME_SERVER, name: `Rename Test ${RUN_HEX}`, ownerId: ALICE_ID })
      .onConflictDoNothing();

    const [renameTask] = await db
      .insert(workspaceTasks)
      .values({ serverId: RENAME_SERVER, title: `Rename Task ${RUN_HEX}` })
      .returning({ id: workspaceTasks.id });

    if (!renameTask) throw new Error('Failed to insert rename task');

    // Two rows for ALICE_ID — same userId, different createdByName ("Alice" vs "Alice Smith")
    await db.insert(workspaceTaskActivity).values([
      {
        serverId: RENAME_SERVER,
        taskId: renameTask.id,
        type: 'task_created',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: new Date(Date.now() - 2000),
      },
      {
        serverId: RENAME_SERVER,
        taskId: renameTask.id,
        type: 'agent_assigned',
        createdById: ALICE_ID,
        createdByName: 'Alice Smith',
        createdAt: new Date(Date.now() - 1000),
      },
    ]);

    try {
      const stats = await memberStats(RENAME_SERVER);

      // Must produce exactly ONE row for ALICE_ID despite two different names
      const aliceRows = stats.filter((s) => s.userId === ALICE_ID);
      expect(aliceRows.length).toBe(1);

      // userName comes from `users.name` (current registered name), not the
      // snapshotted createdByName, so renames in users propagate immediately.
      expect(aliceRows[0].userName).toBe('Alice');

      // Both activity rows must be counted
      expect(aliceRows[0].tasksCreated).toBe(1);
      expect(aliceRows[0].agentsAssigned).toBe(1);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, RENAME_SERVER));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, RENAME_SERVER));
      await db.delete(servers).where(eq(servers.id, RENAME_SERVER));
    }
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

  it('splits rows across day boundaries when rows fall on different UTC days', async () => {
    // Use a separate server to avoid interfering with the main seed counts.
    const DAY_SERVER = `ws_day_test_${RUN_HEX}`;

    await db
      .insert(servers)
      .values({ id: DAY_SERVER, name: `Day Boundary Test ${RUN_HEX}`, ownerId: ALICE_ID })
      .onConflictDoNothing();

    const [dayTask] = await db
      .insert(workspaceTasks)
      .values({ serverId: DAY_SERVER, title: `Day Task ${RUN_HEX}` })
      .returning({ id: workspaceTasks.id });

    if (!dayTask) throw new Error('Failed to insert day task');

    // Row on a fixed past date (2026-01-15) — clearly on a different UTC day than today
    const pastDate = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    // Row on today
    const todayDate = new Date();

    await db.insert(workspaceTaskActivity).values([
      {
        serverId: DAY_SERVER,
        taskId: dayTask.id,
        type: 'task_created',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: pastDate,
      },
      {
        serverId: DAY_SERVER,
        taskId: dayTask.id,
        type: 'agent_assigned',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: todayDate,
      },
    ]);

    try {
      // Window wide enough to span from 2026-01-15 through today
      const startMs = pastDate.getTime() - 1000;
      const endMs   = todayDate.getTime() + 60_000;

      const result = await memberActivity(DAY_SERVER, startMs, endMs, 'day');

      // Must have at least 2 buckets (one for each UTC day)
      expect(result.buckets.length).toBeGreaterThanOrEqual(2);

      // The 2026-01-15 bucket must exist with count 1
      const pastBucket = result.buckets.find((b) => b.period === '2026-01-15');
      expect(pastBucket).toBeDefined();
      const alicePast = pastBucket!.members.find((m) => m.userId === ALICE_ID);
      expect(alicePast).toBeDefined();
      expect(alicePast!.created).toBe(1);
      expect(alicePast!.assigned).toBe(0);
      expect(alicePast!.total).toBe(1);

      // Today's bucket must have the agent_assigned row
      const todayStr = todayDate.toISOString().slice(0, 10);
      const todayBucket = result.buckets.find((b) => b.period === todayStr);
      expect(todayBucket).toBeDefined();
      const aliceToday = todayBucket!.members.find((m) => m.userId === ALICE_ID);
      expect(aliceToday).toBeDefined();
      expect(aliceToday!.assigned).toBe(1);
      expect(aliceToday!.total).toBeGreaterThanOrEqual(1);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, DAY_SERVER));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, DAY_SERVER));
      await db.delete(servers).where(eq(servers.id, DAY_SERVER));
    }
  });

  it('deduplicates a user who appears with two different createdByName values in memberActivity', async () => {
    const RENAME_SERVER = `ws_rename_act_${RUN_HEX}`;

    await db
      .insert(servers)
      .values({ id: RENAME_SERVER, name: `Rename Activity Test ${RUN_HEX}`, ownerId: ALICE_ID })
      .onConflictDoNothing();

    const [renameTask] = await db
      .insert(workspaceTasks)
      .values({ serverId: RENAME_SERVER, title: `Rename Activity Task ${RUN_HEX}` })
      .returning({ id: workspaceTasks.id });

    if (!renameTask) throw new Error('Failed to insert rename activity task');

    const base = Date.now() - 3000;

    // Same ALICE_ID, same day, two different createdByName values
    await db.insert(workspaceTaskActivity).values([
      {
        serverId: RENAME_SERVER,
        taskId: renameTask.id,
        type: 'task_created',
        createdById: ALICE_ID,
        createdByName: 'Alice',
        createdAt: new Date(base),
      },
      {
        serverId: RENAME_SERVER,
        taskId: renameTask.id,
        type: 'agent_assigned',
        createdById: ALICE_ID,
        createdByName: 'Alice Smith',
        createdAt: new Date(base + 1000),
      },
    ]);

    try {
      const startMs = base - 5000;
      const endMs   = base + 60_000;
      const result = await memberActivity(RENAME_SERVER, startMs, endMs, 'day');

      // Exactly one bucket
      expect(result.buckets.length).toBe(1);

      // Exactly one member entry for ALICE_ID (not two groups due to name mismatch)
      const aliceEntries = result.buckets[0].members.filter((m) => m.userId === ALICE_ID);
      expect(aliceEntries.length).toBe(1);

      // userName comes from `users.name` (current registered name), not from
      // the snapshotted createdByName, so renames in users propagate immediately.
      expect(aliceEntries[0].userName).toBe('Alice');

      // Both rows counted
      expect(aliceEntries[0].created).toBe(1);
      expect(aliceEntries[0].assigned).toBe(1);
      expect(aliceEntries[0].total).toBe(2);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, RENAME_SERVER));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, RENAME_SERVER));
      await db.delete(servers).where(eq(servers.id, RENAME_SERVER));
    }
  });

  it('collapses widget-user activity into the linked member account (widget_users.external_user_id)', async () => {
    // Repro of the prod bug where the same human shows up as two legend entries:
    //   • a 'member'  row (created_by_id = users.id, created_by_name = "Admin")
    //   • an 'external' row from a widget comment
    //     (created_by_id = widget_users.id, created_by_name = "J N",
    //      widget_users.external_user_id pointing back to users.id)
    // The chart legend must show one entry under one colour for this person.
    const WIDGET_SERVER  = `ws_widget_act_${RUN_HEX}`;
    const WIDGET_PROJECT = randomBytes(8).toString('hex');

    await db
      .insert(servers)
      .values({ id: WIDGET_SERVER, name: `Widget Activity Test ${RUN_HEX}`, ownerId: ALICE_ID })
      .onConflictDoNothing();

    const [widgetProject] = await db
      .insert(widgetProjects)
      .values({
        serverId: WIDGET_SERVER,
        name: `Widget Project ${RUN_HEX}`,
        slug: `widget-${RUN_HEX}-${WIDGET_PROJECT}`,
        apiKey: `apikey-${RUN_HEX}-${WIDGET_PROJECT}`,
        apiSecretHash: `secret-${RUN_HEX}-${WIDGET_PROJECT}`,
      })
      .returning({ id: widgetProjects.id });
    if (!widgetProject) throw new Error('Failed to insert widget project');

    // Widget user whose external_user_id is ALICE_ID — same human as the member row below.
    const [aliceWidget] = await db
      .insert(widgetUsers)
      .values({
        projectId: widgetProject.id,
        externalUserId: ALICE_ID,
        name: 'J N',
      })
      .returning({ id: widgetUsers.id });
    if (!aliceWidget) throw new Error('Failed to insert widget user');

    const [task] = await db
      .insert(workspaceTasks)
      .values({ serverId: WIDGET_SERVER, title: `Widget Task ${RUN_HEX}` })
      .returning({ id: workspaceTasks.id });
    if (!task) throw new Error('Failed to insert task');

    const base = Date.now() - 3000;

    await db.insert(workspaceTaskActivity).values([
      {
        serverId: WIDGET_SERVER,
        taskId: task.id,
        type: 'task_created',
        createdByType: 'member',
        createdById: ALICE_ID,
        createdByName: 'Admin',
        createdAt: new Date(base),
      },
      {
        serverId: WIDGET_SERVER,
        taskId: task.id,
        type: 'agent_assigned',
        createdByType: 'external',
        createdById: aliceWidget.id,
        createdByName: 'J N',
        createdAt: new Date(base + 1000),
      },
    ]);

    try {
      const startMs = base - 5000;
      const endMs   = base + 60_000;
      const result = await memberActivity(WIDGET_SERVER, startMs, endMs, 'day');

      expect(result.buckets.length).toBe(1);

      // Both rows must collapse to a single member entry under ALICE_ID
      // (the canonical user_id), not split into two by member vs external.
      const aliceEntries = result.buckets[0].members.filter((m) => m.userId === ALICE_ID);
      expect(aliceEntries.length).toBe(1);

      // The widget_users.id must NOT appear as a separate member.
      const widgetEntry = result.buckets[0].members.find((m) => m.userId === aliceWidget.id);
      expect(widgetEntry).toBeUndefined();

      // Display name comes from users.name ('Alice'), not the snapshotted
      // 'Admin' or 'J N' — keeps the legend in sync with the user's profile.
      expect(aliceEntries[0].userName).toBe('Alice');

      // Both rows counted under the merged entry
      expect(aliceEntries[0].created).toBe(1);
      expect(aliceEntries[0].assigned).toBe(1);
      expect(aliceEntries[0].total).toBe(2);
    } finally {
      await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, WIDGET_SERVER));
      await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, WIDGET_SERVER));
      await db.delete(widgetUsers).where(eq(widgetUsers.projectId, widgetProject.id));
      await db.delete(widgetProjects).where(eq(widgetProjects.id, widgetProject.id));
      await db.delete(servers).where(eq(servers.id, WIDGET_SERVER));
    }
  });

  it('week granularity returns a single bucket when all rows fall within one ISO week', async () => {
    // All main seed rows are within the same ~5-second window today, so they
    // all fall in the same ISO week. A week-granularity call must return exactly
    // one bucket (period = Monday of this week).
    const startMs = seedBase - 10_000;
    const endMs   = seedBase + 60_000;

    const result = await memberActivity(SERVER_ID, startMs, endMs, 'week');

    expect(result.buckets).toBeDefined();
    expect(result.buckets.length).toBe(1);

    // The bucket must have both Alice and Bob
    const bucket = result.buckets[0];
    expect(bucket.members.find((m) => m.userId === ALICE_ID)).toBeDefined();
    expect(bucket.members.find((m) => m.userId === BOB_ID)).toBeDefined();
  });

  it('month granularity returns a single bucket when all rows fall within one calendar month', async () => {
    const startMs = seedBase - 10_000;
    const endMs   = seedBase + 60_000;

    const result = await memberActivity(SERVER_ID, startMs, endMs, 'month');

    expect(result.buckets).toBeDefined();
    expect(result.buckets.length).toBe(1);

    // The period must look like YYYY-MM-01 (first day of the month)
    expect(result.buckets[0].period).toMatch(/^\d{4}-\d{2}-01$/);

    const bucket = result.buckets[0];
    expect(bucket.members.find((m) => m.userId === ALICE_ID)).toBeDefined();
    expect(bucket.members.find((m) => m.userId === BOB_ID)).toBeDefined();
  });
});

// Regression: both `done` and `cancelled` status_change entries must count as
// completed. The workspace's old SQLite aggregation used IN ('done', 'cancelled');
// if the BE narrows this to 'done' only, historical "completed" counts on the
// ReportsPage will silently drop.
describe('WorkspaceTaskActivityFeedService — cancelled counts as completed', () => {
  const CANCEL_RUN_HEX = randomBytes(6).toString('hex');
  const CANCEL_SERVER = `ws_cancel_${CANCEL_RUN_HEX}`;
  const CANCELLER_ID = `cancel-${CANCEL_RUN_HEX}`;
  let CANCEL_TASK_ID: string;

  beforeAll(async () => {
    await db
      .insert(servers)
      .values({ id: CANCEL_SERVER, name: 'cancel-test', ownerId: ALICE_ID })
      .onConflictDoNothing();
    const [task] = await db
      .insert(workspaceTasks)
      .values({ serverId: CANCEL_SERVER, title: `Cancel Task ${CANCEL_RUN_HEX}` })
      .returning({ id: workspaceTasks.id });
    if (!task) throw new Error('Failed to insert cancel test task');
    CANCEL_TASK_ID = task.id;
    await db.insert(workspaceTaskActivity).values([
      {
        serverId: CANCEL_SERVER,
        taskId: CANCEL_TASK_ID,
        type: 'status_change',
        metadata: { from: 'in_progress', to: 'cancelled' },
        createdById: CANCELLER_ID,
        createdByName: 'Canceller',
        createdAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(workspaceTaskActivity).where(eq(workspaceTaskActivity.serverId, CANCEL_SERVER));
    await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, CANCEL_SERVER));
    await db.delete(servers).where(eq(servers.id, CANCEL_SERVER));
  });

  it('memberStats counts status_change → cancelled as tasksCompleted', async () => {
    const stats = await memberStats(CANCEL_SERVER);
    const canceller = stats.find((m) => m.userId === CANCELLER_ID);
    expect(canceller).toBeDefined();
    expect(canceller!.tasksCompleted).toBe(1);
  });

  it('memberActivity counts status_change → cancelled in completed', async () => {
    const start = Date.now() - 60_000;
    const end = Date.now() + 60_000;
    const result = await memberActivity(CANCEL_SERVER, start, end, 'day');
    expect(result.buckets.length).toBeGreaterThan(0);
    const canceller = result.buckets[0].members.find((m) => m.userId === CANCELLER_ID);
    expect(canceller).toBeDefined();
    expect(canceller!.completed).toBe(1);
  });
});
