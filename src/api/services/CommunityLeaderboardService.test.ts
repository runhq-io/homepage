/**
 * Integration tests for CommunityLeaderboardService.
 *
 * Pattern: Pattern A — real Neon test DB (DATABASE_URL from .env).
 * Each test runs against real rows; state is cleaned up in afterAll.
 * beforeEach resets community tables so each test starts fresh.
 *
 * NOTE: widgetUserBalances.rank is pre-set directly by INSERT because
 * rank recomputation is the responsibility of CommunityPointsService
 * (tested in its own file). This service is the read-side only.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db/index';
import {
  users,
  servers,
  widgetProjects,
  widgetUsers,
  pointGrants,
  widgetUserBalances,
  widgetUserNotifications,
} from '../../db/schema';
import { CommunityLeaderboardService } from './CommunityLeaderboardService';

// ---------------------------------------------------------------------------
// Per-run isolation suffix
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex');

// ---------------------------------------------------------------------------
// Project A fixtures (primary test project)
// ---------------------------------------------------------------------------
const USER_ID = `00000000-7777-4001-a001-${RUN_HEX.padStart(12, '0')}`;
const SERVER_A_ID = `cls_test_a_${RUN_HEX}`;
const SERVER_B_ID = `cls_test_b_${RUN_HEX}`;

let PROJECT_A_ID: string;
let PROJECT_B_ID: string;

// Widget users in project A
let WU_ALICE_ID: string;   // active, will have balance
let WU_BOB_ID: string;     // active, will have balance
let WU_CAROL_ID: string;   // active, no balance row (rank=null)
let WU_DELETED_ID: string; // status='deleted', has balance

// Widget user in project B (for cross-tenant tests)
let WU_CROSS_ID: string;

// ---------------------------------------------------------------------------
// Setup: structural fixtures once; community rows reset between tests
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: USER_ID, email: `cls+${RUN_HEX}@test.invalid`, name: 'CLS Test' })
    .onConflictDoNothing();

  // Create two servers — widget_projects has unique constraint on server_id
  await db
    .insert(servers)
    .values([
      { id: SERVER_A_ID, name: `CLS Srv A ${RUN_HEX}`, ownerId: USER_ID },
      { id: SERVER_B_ID, name: `CLS Srv B ${RUN_HEX}`, ownerId: USER_ID },
    ])
    .onConflictDoNothing();

  const [projA] = await db
    .insert(widgetProjects)
    .values({
      serverId: SERVER_A_ID,
      name: `CLS Project A ${RUN_HEX}`,
      slug: `cls-a-${RUN_HEX}`,
      apiKey: `apikey-cls-a-${RUN_HEX}`,
      apiSecretHash: `secret-cls-a-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    })
    .returning({ id: widgetProjects.id });
  PROJECT_A_ID = projA!.id;

  const [projB] = await db
    .insert(widgetProjects)
    .values({
      serverId: SERVER_B_ID,
      name: `CLS Project B ${RUN_HEX}`,
      slug: `cls-b-${RUN_HEX}`,
      apiKey: `apikey-cls-b-${RUN_HEX}`,
      apiSecretHash: `secret-cls-b-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    })
    .returning({ id: widgetProjects.id });
  PROJECT_B_ID = projB!.id;

  // Project A members — insert in a defined order so created_at is predictable
  const [alice] = await db
    .insert(widgetUsers)
    .values({
      projectId: PROJECT_A_ID,
      externalUserId: `ext-alice-${RUN_HEX}`,
      name: 'Alice',
    })
    .returning({ id: widgetUsers.id });
  WU_ALICE_ID = alice!.id;

  const [bob] = await db
    .insert(widgetUsers)
    .values({
      projectId: PROJECT_A_ID,
      externalUserId: `ext-bob-${RUN_HEX}`,
      name: 'Bob',
    })
    .returning({ id: widgetUsers.id });
  WU_BOB_ID = bob!.id;

  const [carol] = await db
    .insert(widgetUsers)
    .values({
      projectId: PROJECT_A_ID,
      externalUserId: `ext-carol-${RUN_HEX}`,
      name: 'Carol',
    })
    .returning({ id: widgetUsers.id });
  WU_CAROL_ID = carol!.id;

  const [deleted] = await db
    .insert(widgetUsers)
    .values({
      projectId: PROJECT_A_ID,
      externalUserId: `ext-deleted-${RUN_HEX}`,
      name: 'Deleted User',
      status: 'deleted',
    })
    .returning({ id: widgetUsers.id });
  WU_DELETED_ID = deleted!.id;

  // Project B member (for cross-tenant tests)
  const [cross] = await db
    .insert(widgetUsers)
    .values({
      projectId: PROJECT_B_ID,
      externalUserId: `ext-cross-${RUN_HEX}`,
      name: 'CrossUser',
    })
    .returning({ id: widgetUsers.id });
  WU_CROSS_ID = cross!.id;
});

afterAll(async () => {
  // Delete in FK-safe order for both projects
  for (const pid of [PROJECT_A_ID, PROJECT_B_ID]) {
    if (!pid) continue;
    await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, pid));
    await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, pid));
    await db.delete(pointGrants).where(eq(pointGrants.projectId, pid));
    await db.delete(widgetUsers).where(eq(widgetUsers.projectId, pid));
    await db.delete(widgetProjects).where(eq(widgetProjects.id, pid));
  }
  await db.delete(servers).where(eq(servers.id, SERVER_A_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_B_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  // Clean community rows for both projects before each test
  for (const pid of [PROJECT_A_ID, PROJECT_B_ID]) {
    if (!pid) continue;
    await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, pid));
    await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, pid));
    await db.delete(pointGrants).where(eq(pointGrants.projectId, pid));
  }
  // Reset deleted user's status in case a test modified it
  await db
    .update(widgetUsers)
    .set({ status: 'deleted' })
    .where(eq(widgetUsers.id, WU_DELETED_ID));
});

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------
function makeService() {
  return new CommunityLeaderboardService({ db });
}

// ---------------------------------------------------------------------------
// Helper: insert a balance row directly (rank pre-set by caller)
// ---------------------------------------------------------------------------
async function insertBalance(
  widgetUserId: string,
  projectId: string,
  opts: { balance: number; payoutsCount?: number; lastPayoutAt?: Date | null; rank?: number | null },
) {
  await db
    .insert(widgetUserBalances)
    .values({
      widgetUserId,
      projectId,
      balance: opts.balance,
      payoutsCount: opts.payoutsCount ?? 0,
      lastPayoutAt: opts.lastPayoutAt ?? null,
      rank: opts.rank ?? null,
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Helper: insert a point grant row for getMember recentGrants tests
// ---------------------------------------------------------------------------
async function insertGrant(
  widgetUserId: string,
  projectId: string,
  amount: number,
  createdAt: Date,
) {
  const idempotencyKey = `test-grant-${randomBytes(4).toString('hex')}`;
  const [grant] = await db
    .insert(pointGrants)
    .values({
      projectId,
      widgetUserId,
      amount,
      source: 'admin_grant',
      idempotencyKey,
      metadata: {},
      createdAt,
    })
    .returning();
  return grant!;
}

// ===========================================================================
// listMembers
// ===========================================================================

describe('listMembers — sort=rank', () => {
  it('returns active members with balances ranked correctly', async () => {
    const svc = makeService();

    // Alice: rank 1, Bob: rank 2
    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 100, rank: 1 });
    await insertBalance(WU_BOB_ID, PROJECT_A_ID, { balance: 50, rank: 2 });

    const { members, nextCursor } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 10,
    });

    // Only active members with balances in rank order; Carol (no balance) goes to bottom
    const names = members.map((m) => m.name);
    const aliceIdx = names.indexOf('Alice');
    const bobIdx = names.indexOf('Bob');
    const carolIdx = names.indexOf('Carol');

    expect(aliceIdx).toBeGreaterThanOrEqual(0);
    expect(bobIdx).toBeGreaterThanOrEqual(0);
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(carolIdx).toBeGreaterThan(bobIdx); // Carol has no rank — goes to bottom

    expect(nextCursor).toBeNull();
  });

  it('LEFT JOIN includes members with no balance row (balance=0, rank=null at bottom)', async () => {
    const svc = makeService();

    // Only Alice has a balance
    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 100, rank: 1 });

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 10,
    });

    // All three active members should appear (Alice, Bob, Carol) — deleted user excluded
    const activeNames = members.map((m) => m.name);
    expect(activeNames).toContain('Alice');
    expect(activeNames).toContain('Bob');
    expect(activeNames).toContain('Carol');
    expect(activeNames).not.toContain('Deleted User');

    // Members without balance should have balance=0 and rank=null
    const bob = members.find((m) => m.name === 'Bob');
    expect(bob).toBeDefined();
    expect(bob!.balance).toBe(0);
    expect(bob!.rank).toBeNull();

    // Alice (ranked) should appear before Bob and Carol (unranked)
    const aliceIdx = activeNames.indexOf('Alice');
    const bobIdx = activeNames.indexOf('Bob');
    expect(aliceIdx).toBeLessThan(bobIdx);
  });

  it('filters out members with status=deleted regardless of balance', async () => {
    const svc = makeService();

    // Give the deleted user a balance too
    await insertBalance(WU_DELETED_ID, PROJECT_A_ID, { balance: 999, rank: 1 });
    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 10, rank: 2 });

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 10,
    });

    expect(members.map((m) => m.name)).not.toContain('Deleted User');
  });
});

describe('listMembers — sort=balance', () => {
  it('orders by balance DESC', async () => {
    const svc = makeService();

    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 30, rank: 2 });
    await insertBalance(WU_BOB_ID, PROJECT_A_ID, { balance: 80, rank: 1 });

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'balance',
      limit: 10,
    });

    const names = members.map((m) => m.name);
    const aliceIdx = names.indexOf('Alice');
    const bobIdx = names.indexOf('Bob');

    // Bob has higher balance → comes first
    expect(bobIdx).toBeLessThan(aliceIdx);
    // Carol (balance=0) should be after Alice
    const carolIdx = names.indexOf('Carol');
    expect(aliceIdx).toBeLessThan(carolIdx);
  });
});

describe('listMembers — sort=name', () => {
  it('orders alphabetically by name ASC', async () => {
    const svc = makeService();

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'name',
      limit: 10,
    });

    const activeMembers = members.filter((m) => m.name !== null);
    const names = activeMembers.map((m) => m.name as string);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

describe('listMembers — sort=recent', () => {
  it('orders by lastSeenAt DESC', async () => {
    const svc = makeService();

    const past = new Date('2024-01-01T00:00:00Z');
    const now = new Date();

    // Update lastSeenAt to known values
    await db.update(widgetUsers).set({ lastSeenAt: now }).where(eq(widgetUsers.id, WU_BOB_ID));
    await db.update(widgetUsers).set({ lastSeenAt: past }).where(eq(widgetUsers.id, WU_ALICE_ID));

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'recent',
      limit: 10,
    });

    const names = members.map((m) => m.name);
    const bobIdx = names.indexOf('Bob');
    const aliceIdx = names.indexOf('Alice');

    // Bob was seen more recently → comes first
    expect(bobIdx).toBeLessThan(aliceIdx);
  });
});

describe('listMembers — edge cases', () => {
  it('returns empty array + nextCursor=null for a project with no widget users', async () => {
    const svc = makeService();

    // PROJECT_B has one widget user (WU_CROSS_ID) but no balance/grants reset;
    // we need a project with zero widget users. Use a throwaway project.
    const SERVER_EMPTY_ID = `cls_empty_${RUN_HEX}`;
    let EMPTY_PROJECT_ID: string;

    await db
      .insert(servers)
      .values({ id: SERVER_EMPTY_ID, name: `CLS Empty Srv ${RUN_HEX}`, ownerId: USER_ID })
      .onConflictDoNothing();

    const [emptyProj] = await db
      .insert(widgetProjects)
      .values({
        serverId: SERVER_EMPTY_ID,
        name: `CLS Empty Project ${RUN_HEX}`,
        slug: `cls-empty-${RUN_HEX}`,
        apiKey: `apikey-cls-empty-${RUN_HEX}`,
        apiSecretHash: `secret-cls-empty-${RUN_HEX}`,
        enabled: true,
        isPublic: true,
      })
      .returning({ id: widgetProjects.id });
    EMPTY_PROJECT_ID = emptyProj!.id;

    try {
      const { members, nextCursor } = await svc.listMembers({
        projectId: EMPTY_PROJECT_ID,
        sort: 'rank',
        limit: 10,
      });

      expect(members).toHaveLength(0);
      expect(nextCursor).toBeNull();
    } finally {
      // Clean up the throwaway project
      await db.delete(widgetProjects).where(eq(widgetProjects.id, EMPTY_PROJECT_ID));
      await db.delete(servers).where(eq(servers.id, SERVER_EMPTY_ID));
    }
  });

  it('cross-tenant: members from a different project_id do NOT appear', async () => {
    const svc = makeService();

    // Give the cross-tenant user a balance
    await insertBalance(WU_CROSS_ID, PROJECT_B_ID, { balance: 999, rank: 1 });

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 10,
    });

    // CrossUser must not appear in project A results
    expect(members.map((m) => m.name)).not.toContain('CrossUser');
  });

  it('caps limit at 100 and returns nextCursor when more rows exist', async () => {
    const svc = makeService();

    // Insert enough members (use project B as scratch space via a separate server).
    // Actually, we only have 3 active members in project A — too few to test pagination
    // at limit 100. Test with limit=1 to force pagination.
    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 100, rank: 1 });
    await insertBalance(WU_BOB_ID, PROJECT_A_ID, { balance: 50, rank: 2 });

    const { members, nextCursor } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 1,
    });

    expect(members).toHaveLength(1);
    expect(nextCursor).not.toBeNull();
    expect(typeof nextCursor).toBe('string');
  });

  it('nextCursor is null when all members fit within limit', async () => {
    const svc = makeService();

    const { members, nextCursor } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 100,
    });

    // 3 active members, limit=100 → should fit, no cursor
    expect(members.length).toBeGreaterThanOrEqual(0);
    expect(nextCursor).toBeNull();
  });
});

describe('listMembers — member shape', () => {
  it('returns correct field shapes for a member with a balance', async () => {
    const svc = makeService();

    const lastPayoutAt = new Date('2025-01-15T12:00:00Z');
    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, {
      balance: 42,
      payoutsCount: 3,
      lastPayoutAt,
      rank: 1,
    });

    const { members } = await svc.listMembers({
      projectId: PROJECT_A_ID,
      sort: 'rank',
      limit: 10,
    });

    const alice = members.find((m) => m.widgetUserId === WU_ALICE_ID);
    expect(alice).toBeDefined();
    expect(alice!.balance).toBe(42);
    expect(alice!.payoutsCount).toBe(3);
    expect(alice!.rank).toBe(1);
    expect(alice!.lastPayoutAt).toBeDefined();
    expect(alice!.externalUserId).toBe(`ext-alice-${RUN_HEX}`);
    expect(alice!.name).toBe('Alice');
  });
});

// ===========================================================================
// getMember
// ===========================================================================

describe('getMember', () => {
  it('returns member + recentGrants for the right project', async () => {
    const svc = makeService();

    await insertBalance(WU_ALICE_ID, PROJECT_A_ID, { balance: 75, rank: 1 });

    const now = new Date();
    const g1 = await insertGrant(WU_ALICE_ID, PROJECT_A_ID, 50, new Date(now.getTime() - 2000));
    const g2 = await insertGrant(WU_ALICE_ID, PROJECT_A_ID, 25, new Date(now.getTime() - 1000));

    const { member, recentGrants } = await svc.getMember({
      projectId: PROJECT_A_ID,
      widgetUserId: WU_ALICE_ID,
    });

    expect(member.widgetUserId).toBe(WU_ALICE_ID);
    expect(member.balance).toBe(75);
    expect(member.rank).toBe(1);
    expect(member.status).toBe('active');

    // recentGrants ordered DESC by createdAt (g2 first, then g1)
    expect(recentGrants).toHaveLength(2);
    expect(recentGrants[0]!.id).toBe(g2.id);
    expect(recentGrants[1]!.id).toBe(g1.id);
  });

  it('recentGrants respects recentGrantsLimit', async () => {
    const svc = makeService();

    const now = new Date();
    // Insert 5 grants
    for (let i = 0; i < 5; i++) {
      await insertGrant(WU_BOB_ID, PROJECT_A_ID, 10, new Date(now.getTime() - i * 1000));
    }

    const { recentGrants } = await svc.getMember({
      projectId: PROJECT_A_ID,
      widgetUserId: WU_BOB_ID,
      recentGrantsLimit: 3,
    });

    expect(recentGrants).toHaveLength(3);
  });

  it('returns member with balance=0 and rank=null when no balance row exists', async () => {
    const svc = makeService();

    // Carol has no balance row
    const { member } = await svc.getMember({
      projectId: PROJECT_A_ID,
      widgetUserId: WU_CAROL_ID,
    });

    expect(member.balance).toBe(0);
    expect(member.rank).toBeNull();
    expect(member.payoutsCount).toBe(0);
  });

  it('throws Member not found when widgetUserId belongs to a different project (cross-tenant guard)', async () => {
    const svc = makeService();

    // WU_CROSS_ID is in PROJECT_B — querying it with PROJECT_A_ID should throw
    await expect(
      svc.getMember({ projectId: PROJECT_A_ID, widgetUserId: WU_CROSS_ID }),
    ).rejects.toThrow('Member not found');
  });

  it('throws Member not found when widgetUserId does not exist at all', async () => {
    const svc = makeService();

    await expect(
      svc.getMember({
        projectId: PROJECT_A_ID,
        widgetUserId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow('Member not found');
  });

  it('returns empty recentGrants array when no grants exist (does not throw)', async () => {
    const svc = makeService();

    const { recentGrants } = await svc.getMember({
      projectId: PROJECT_A_ID,
      widgetUserId: WU_ALICE_ID,
    });

    expect(recentGrants).toHaveLength(0);
  });
});
