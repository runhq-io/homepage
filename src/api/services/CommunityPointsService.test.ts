/**
 * Integration tests for CommunityPointsService.
 *
 * Pattern: Pattern A — real Neon test DB (DATABASE_URL from .env).
 * Each test runs against real rows; state is cleaned up in afterAll.
 * beforeEach resets community tables so each test starts fresh.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
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
  workspaceTasks,
  workspaceTaskVotes,
} from '../../db/schema';
import { CommunityPointsService } from './CommunityPointsService';
import type { StatusChangeEvent } from './communityAwardingPolicy';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
const RUN_HEX = randomBytes(6).toString('hex');
const SERVER_ID = `cps_test_${RUN_HEX}`;
const USER_ID = `00000000-7777-4000-a000-${RUN_HEX.padStart(12, '0')}`;
let PROJECT_ID: string;
let WIDGET_USER_ID: string;
let WIDGET_USER_ID_B: string;
let WIDGET_USER_ID_C: string;

// ---------------------------------------------------------------------------
// Seed: create the structural fixtures once; reset community rows between tests
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await db
    .insert(users)
    .values({ id: USER_ID, email: `cps+${RUN_HEX}@test.invalid`, name: 'CPS Test' })
    .onConflictDoNothing();
  await db
    .insert(servers)
    .values({ id: SERVER_ID, name: `CPS Srv ${RUN_HEX}`, ownerId: USER_ID })
    .onConflictDoNothing();
  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId: SERVER_ID,
      name: `CPS Project ${RUN_HEX}`,
      slug: `cps-${RUN_HEX}`,
      apiKey: `apikey-cps-${RUN_HEX}`,
      apiSecretHash: `secret-cps-${RUN_HEX}`,
      enabled: true,
      isPublic: true,
    })
    .returning({ id: widgetProjects.id });
  PROJECT_ID = project!.id;

  const [wu] = await db
    .insert(widgetUsers)
    .values({ projectId: PROJECT_ID, externalUserId: `ext-a-${RUN_HEX}`, name: 'Alice' })
    .returning({ id: widgetUsers.id });
  WIDGET_USER_ID = wu!.id;

  const [wu2] = await db
    .insert(widgetUsers)
    .values({ projectId: PROJECT_ID, externalUserId: `ext-b-${RUN_HEX}`, name: 'Bob' })
    .returning({ id: widgetUsers.id });
  WIDGET_USER_ID_B = wu2!.id;

  const [wu3] = await db
    .insert(widgetUsers)
    .values({ projectId: PROJECT_ID, externalUserId: `ext-c-${RUN_HEX}`, name: 'Carol' })
    .returning({ id: widgetUsers.id });
  WIDGET_USER_ID_C = wu3!.id;
});

afterAll(async () => {
  // Delete in FK-safe order
  await db
    .delete(widgetUserNotifications)
    .where(eq(widgetUserNotifications.projectId, PROJECT_ID));
  await db
    .delete(widgetUserBalances)
    .where(eq(widgetUserBalances.projectId, PROJECT_ID));
  await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_ID));
  await db.delete(workspaceTaskVotes).where(eq(workspaceTaskVotes.serverId, SERVER_ID));
  await db.delete(workspaceTasks).where(eq(workspaceTasks.serverId, SERVER_ID));
  await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_ID));
  await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
});

beforeEach(async () => {
  // Reset community-specific rows between tests so each test is independent.
  await db
    .delete(widgetUserNotifications)
    .where(eq(widgetUserNotifications.projectId, PROJECT_ID));
  await db
    .delete(widgetUserBalances)
    .where(eq(widgetUserBalances.projectId, PROJECT_ID));
  await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_ID));
});

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------
function makeUUID(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeEvent(overrides: Partial<StatusChangeEvent> = {}): StatusChangeEvent {
  return {
    ticketId: makeUUID(),
    projectId: PROJECT_ID,
    sourceType: 'widget',
    externalUserId: `ext-a-${RUN_HEX}`,
    oldStatus: 'in_progress',
    newStatus: 'done',
    upvoteCountAtTransition: 0,
    selfUpvoted: false,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeService(publishFn = vi.fn()): { service: CommunityPointsService; published: unknown[] } {
  const published: unknown[] = [];
  const publish = (topic: string, payload: unknown) => {
    published.push({ topic, payload });
    publishFn(topic, payload);
  };
  const service = new CommunityPointsService({ db, publish });
  return { service, published };
}

// ---------------------------------------------------------------------------
// awardForCompletion
// ---------------------------------------------------------------------------
describe('awardForCompletion', () => {
  it('inserts grant, updates balance, publishes both events', async () => {
    const { service, published } = makeService();
    const ticketId = makeUUID();
    const event = makeEvent({ ticketId, upvoteCountAtTransition: 3, selfUpvoted: true });
    // Expected: 10 base + (3 - 1 self) = 12

    const result = await service.awardForCompletion(event);

    expect(result.applied).toBe(true);
    expect(result.amount).toBe(12);
    expect(typeof result.grantId).toBe('string');

    // Grant row
    const [grant] = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.id, result.grantId!));
    expect(grant).toBeDefined();
    expect(grant!.source).toBe('auto_completion');
    expect(grant!.amount).toBe(12);
    expect(grant!.widgetUserId).toBe(WIDGET_USER_ID);
    expect(grant!.idempotencyKey).toBe(`auto_completion:${ticketId}`);
    expect((grant!.metadata as any).upvoteCountAtTransition).toBe(3);
    expect((grant!.metadata as any).selfUpvoted).toBe(true);

    // Balance row
    const [balance] = await db
      .select()
      .from(widgetUserBalances)
      .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(balance).toBeDefined();
    expect(balance!.balance).toBe(12);
    expect(balance!.payoutsCount).toBe(1);
    expect(balance!.lastPayoutAt).not.toBeNull();

    // Notification row
    const notifs = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe('points.awarded');
    const payload = notifs[0]!.payload as any;
    expect(payload.amount).toBe(12);
    expect(payload.grantId).toBe(result.grantId);

    // PubSub events
    expect(published).toHaveLength(2);
    const communityEvt = published.find((p: any) => p.topic === `community:${PROJECT_ID}`) as any;
    expect(communityEvt).toBeDefined();
    expect(communityEvt.payload.type).toBe('community_balance_changed');
    expect(communityEvt.payload.projectId).toBe(PROJECT_ID);
    expect(communityEvt.payload.widgetUserId).toBe(WIDGET_USER_ID);
    expect(typeof communityEvt.payload.oldBalance).toBe('number');
    expect(typeof communityEvt.payload.newBalance).toBe('number');
    expect(communityEvt.payload.newBalance).toBe(12);
    expect(communityEvt.payload.grantId).toBe(result.grantId);

    const userEvt = published.find(
      (p: any) => p.topic === `community:widget_user:${WIDGET_USER_ID}`,
    ) as any;
    expect(userEvt).toBeDefined();
    expect(userEvt.payload.type).toBe('community_notification');
    expect(userEvt.payload.projectId).toBe(PROJECT_ID);
    expect(userEvt.payload.widgetUserId).toBe(WIDGET_USER_ID);
    expect(typeof userEvt.payload.notificationId).toBe('string');
  });

  it('is idempotent: second call with same ticketId returns {applied:false}, no duplicates', async () => {
    const { service, published } = makeService();
    const ticketId = makeUUID();
    const event = makeEvent({ ticketId });

    const first = await service.awardForCompletion(event);
    expect(first.applied).toBe(true);

    published.length = 0; // reset captured events

    const second = await service.awardForCompletion(event);
    expect(second.applied).toBe(false);

    // Only one grant in the ledger
    const grants = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.idempotencyKey, `auto_completion:${ticketId}`));
    expect(grants).toHaveLength(1);

    // No second notification
    const notifs = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    expect(notifs).toHaveLength(1);

    // No second pubsub
    expect(published).toHaveLength(0);
  });

  it('returns {applied:false} when sourceType is native', async () => {
    const { service, published } = makeService();
    const event = makeEvent({ sourceType: 'native' });
    const result = await service.awardForCompletion(event);
    expect(result.applied).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('returns {applied:false} when widget_user row does not exist for (projectId, externalUserId)', async () => {
    const { service, published } = makeService();
    const event = makeEvent({ externalUserId: 'nonexistent-user-xyz' });
    const result = await service.awardForCompletion(event);
    expect(result.applied).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('returns {applied:false} when oldStatus is already a terminal-success status', async () => {
    const { service } = makeService();
    const event = makeEvent({ oldStatus: 'done', newStatus: 'deployed' });
    const result = await service.awardForCompletion(event);
    expect(result.applied).toBe(false);
  });

  it('returns {applied:false} when newStatus is not terminal', async () => {
    const { service } = makeService();
    const event = makeEvent({ newStatus: 'in_progress' });
    const result = await service.awardForCompletion(event);
    expect(result.applied).toBe(false);
  });

  it('accumulates balance on multiple distinct tickets', async () => {
    const { service } = makeService();
    const event1 = makeEvent({ upvoteCountAtTransition: 0, selfUpvoted: false }); // 10 pts
    const event2 = makeEvent({ upvoteCountAtTransition: 5, selfUpvoted: false }); // 15 pts

    await service.awardForCompletion(event1);
    await service.awardForCompletion(event2);

    const [balance] = await db
      .select()
      .from(widgetUserBalances)
      .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(balance!.balance).toBe(25);
    expect(balance!.payoutsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// grantBonus
// ---------------------------------------------------------------------------
describe('grantBonus', () => {
  it('writes admin grant, updates balance, publishes events, inserts points.bonus notification', async () => {
    const { service, published } = makeService();
    const clientRequestId = `req-${randomBytes(4).toString('hex')}`;

    const { grant, newBalance } = await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 50,
      reason: 'Excellent contribution',
      reasonCode: 'excellent',
      grantedByUserId: USER_ID,
      clientRequestId,
    });

    expect(grant.source).toBe('admin_grant');
    expect(grant.amount).toBe(50);
    expect(grant.reason).toBe('Excellent contribution');
    expect(grant.reasonCode).toBe('excellent');
    expect(newBalance.balance).toBe(50);
    // admin_grant does NOT bump payoutsCount
    expect(newBalance.payoutsCount).toBe(0);
    // lastPayoutAt is NOT set by bonus
    expect(newBalance.lastPayoutAt).toBeNull();

    // Notification
    const notifs = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe('points.bonus');

    // PubSub
    expect(published).toHaveLength(2);
    const communityEvt = published.find((p: any) => p.topic === `community:${PROJECT_ID}`) as any;
    expect(communityEvt.payload.type).toBe('community_balance_changed');
    expect(communityEvt.payload.projectId).toBe(PROJECT_ID);
    const userEvt = published.find(
      (p: any) => p.topic === `community:widget_user:${WIDGET_USER_ID}`,
    ) as any;
    expect(userEvt).toBeDefined();
    expect(userEvt.payload.type).toBe('community_notification');
  });

  it('is idempotent on clientRequestId: second call returns same grant, no double-credit', async () => {
    const { service, published } = makeService();
    const clientRequestId = `req-${randomBytes(4).toString('hex')}`;

    const first = await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 30,
      reason: 'First grant',
      clientRequestId,
    });

    published.length = 0;

    const second = await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 30,
      reason: 'First grant',
      clientRequestId,
    });

    // Same grant returned
    expect(second.grant.id).toBe(first.grant.id);
    // Balance was only credited once
    expect(second.newBalance.balance).toBe(30);

    // No second pubsub
    expect(published).toHaveLength(0);

    // Only one grant in ledger
    const grants = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.idempotencyKey, `admin_grant:${clientRequestId}`));
    expect(grants).toHaveLength(1);
  });

  it('supports negative amounts (admin deduction)', async () => {
    const { service } = makeService();
    // First give 50
    await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 50,
      reason: 'Initial',
      clientRequestId: `req-pos-${RUN_HEX}`,
    });
    // Then deduct 20
    const { newBalance } = await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: -20,
      reason: 'Correction',
      clientRequestId: `req-neg-${RUN_HEX}`,
    });
    expect(newBalance.balance).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// reverseGrant
// ---------------------------------------------------------------------------
describe('reverseGrant', () => {
  it('inserts reversal row with negative amount, balance returns to pre-grant level', async () => {
    const { service } = makeService();
    // Setup: give Alice 10 points via auto-completion
    const event = makeEvent({ upvoteCountAtTransition: 0, selfUpvoted: false }); // 10 pts
    const awarded = await service.awardForCompletion(event);
    expect(awarded.applied).toBe(true);
    const originalGrantId = awarded.grantId!;

    const { reversal } = await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: originalGrantId,
      reason: 'Awarded in error',
      grantedByUserId: USER_ID,
      clientRequestId: `rev-${randomBytes(4).toString('hex')}`,
    });

    expect(reversal.source).toBe('reversal');
    expect(reversal.amount).toBe(-10);
    expect(reversal.reversesGrantId).toBe(originalGrantId);

    // Balance should be back to 0
    const [balance] = await db
      .select()
      .from(widgetUserBalances)
      .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(balance!.balance).toBe(0);
    // payoutsCount is NOT decremented by reversal
    expect(balance!.payoutsCount).toBe(1);
  });

  it('original grant remains in ledger (not deleted)', async () => {
    const { service } = makeService();
    const event = makeEvent();
    const awarded = await service.awardForCompletion(event);
    const originalGrantId = awarded.grantId!;

    await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: originalGrantId,
      reason: 'Error',
      grantedByUserId: USER_ID,
      clientRequestId: `rev2-${randomBytes(4).toString('hex')}`,
    });

    const [original] = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.id, originalGrantId));
    expect(original).toBeDefined();
    expect(original!.source).toBe('auto_completion');

    const totalGrants = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.projectId, PROJECT_ID));
    expect(totalGrants).toHaveLength(2); // original + reversal
  });

  it('does NOT insert a notification for the reversed user', async () => {
    const { service, published } = makeService();
    const event = makeEvent();
    const awarded = await service.awardForCompletion(event);
    published.length = 0;

    await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: awarded.grantId!,
      reason: 'Error',
      grantedByUserId: USER_ID,
      clientRequestId: `rev3-${randomBytes(4).toString('hex')}`,
    });

    const notifs = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    // Only the original award notification — no new one from reversal
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe('points.awarded');

    // Only community-level pubsub, no per-user notification topic
    expect(published).toHaveLength(1);
    expect((published[0] as any).topic).toBe(`community:${PROJECT_ID}`);
  });

  it('throws when trying to reverse a reversal', async () => {
    const { service } = makeService();
    const event = makeEvent();
    const awarded = await service.awardForCompletion(event);

    const { reversal } = await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: awarded.grantId!,
      reason: 'Error',
      grantedByUserId: USER_ID,
      clientRequestId: `rev4-${randomBytes(4).toString('hex')}`,
    });

    await expect(
      service.reverseGrant({
        projectId: PROJECT_ID,
        grantId: reversal.id,
        reason: 'Cannot reverse reversal',
        grantedByUserId: USER_ID,
        clientRequestId: `rev5-${randomBytes(4).toString('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'cannot_reverse_reversal' });
  });

  it('throws on missing grant', async () => {
    const { service } = makeService();
    await expect(
      service.reverseGrant({
        projectId: PROJECT_ID,
        grantId: '00000000-0000-0000-0000-000000000000',
        reason: 'Missing',
        grantedByUserId: USER_ID,
        clientRequestId: `rev6-${randomBytes(4).toString('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'grant_not_found' });
  });

  it('is idempotent on clientRequestId: second reversal call returns same reversal row', async () => {
    const { service, published } = makeService();
    const event = makeEvent({ upvoteCountAtTransition: 0, selfUpvoted: false });
    const awarded = await service.awardForCompletion(event);
    published.length = 0;

    const clientRequestId = `rev-idem-${randomBytes(4).toString('hex')}`;
    const first = await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: awarded.grantId!,
      reason: 'Error',
      grantedByUserId: USER_ID,
      clientRequestId,
    });
    published.length = 0;

    const second = await service.reverseGrant({
      projectId: PROJECT_ID,
      grantId: awarded.grantId!,
      reason: 'Error',
      grantedByUserId: USER_ID,
      clientRequestId,
    });

    expect(second.reversal.id).toBe(first.reversal.id);
    // No second pubsub
    expect(published).toHaveLength(0);
    // Balance unchanged at 0
    const [balance] = await db
      .select()
      .from(widgetUserBalances)
      .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(balance!.balance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reverseGrant cross-tenant guard
// ---------------------------------------------------------------------------
describe('reverseGrant cross-tenant guard', () => {
  let PROJECT_B_ID: string;
  let WIDGET_USER_B_ID: string;
  const SERVER_B_ID = `cps_test_b_${RUN_HEX}`;

  beforeAll(async () => {
    // Each project requires a distinct server (unique constraint on server_id).
    await db
      .insert(servers)
      .values({ id: SERVER_B_ID, name: `CPS Srv B ${RUN_HEX}`, ownerId: USER_ID })
      .onConflictDoNothing();

    const [projB] = await db
      .insert(widgetProjects)
      .values({
        serverId: SERVER_B_ID,
        name: `CPS Project B ${RUN_HEX}`,
        slug: `cps-b-${RUN_HEX}`,
        apiKey: `apikey-cps-b-${RUN_HEX}`,
        apiSecretHash: `secret-cps-b-${RUN_HEX}`,
        enabled: true,
        isPublic: true,
      })
      .returning({ id: widgetProjects.id });
    PROJECT_B_ID = projB!.id;

    const [wu] = await db
      .insert(widgetUsers)
      .values({ projectId: PROJECT_B_ID, externalUserId: `ext-b-cross-${RUN_HEX}`, name: 'CrossB' })
      .returning({ id: widgetUsers.id });
    WIDGET_USER_B_ID = wu!.id;
  });

  afterAll(async () => {
    await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, PROJECT_B_ID));
    await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, PROJECT_B_ID));
    await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_B_ID));
    await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_B_ID));
    await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_B_ID));
    await db.delete(servers).where(eq(servers.id, SERVER_B_ID));
  });

  it('throws when grantId belongs to a different project', async () => {
    const { service } = makeService();

    // Create a grant under project B
    const { grant: grantB } = await service.grantBonus({
      projectId: PROJECT_B_ID,
      widgetUserId: WIDGET_USER_B_ID,
      amount: 20,
      reason: 'Project B bonus',
      clientRequestId: `cross-grant-${randomBytes(4).toString('hex')}`,
    });

    // Attempt to reverse the project-B grant using project A's projectId
    await expect(
      service.reverseGrant({
        projectId: PROJECT_ID,
        grantId: grantB.id,
        reason: 'Cross-tenant attack',
        grantedByUserId: USER_ID,
        clientRequestId: `cross-rev-${randomBytes(4).toString('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'cross_tenant_grant' });

    // Verify no reversal row was inserted under either project
    const reversalsInA = await db
      .select()
      .from(pointGrants)
      .where(and(eq(pointGrants.projectId, PROJECT_ID), eq(pointGrants.source, 'reversal')));
    expect(reversalsInA).toHaveLength(0);

    const reversalsInB = await db
      .select()
      .from(pointGrants)
      .where(and(eq(pointGrants.projectId, PROJECT_B_ID), eq(pointGrants.source, 'reversal')));
    expect(reversalsInB).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// grantBonus cross-tenant guard
// ---------------------------------------------------------------------------
describe('grantBonus cross-tenant guard', () => {
  let PROJECT_C_ID: string;
  let WIDGET_USER_C_ID: string;
  // widget_projects has a unique constraint on server_id, so each project needs its own server.
  const SERVER_C_ID = `cps_test_c_${RUN_HEX}`;

  beforeAll(async () => {
    // Create a dedicated server + isolated project + widget user for cross-tenant tests.
    await db
      .insert(servers)
      .values({ id: SERVER_C_ID, name: `CPS Srv C ${RUN_HEX}`, ownerId: USER_ID })
      .onConflictDoNothing();

    const [projC] = await db
      .insert(widgetProjects)
      .values({
        serverId: SERVER_C_ID,
        name: `CPS Project C ${RUN_HEX}`,
        slug: `cps-c-${RUN_HEX}`,
        apiKey: `apikey-cps-c-${RUN_HEX}`,
        apiSecretHash: `secret-cps-c-${RUN_HEX}`,
        enabled: true,
        isPublic: true,
      })
      .returning({ id: widgetProjects.id });
    PROJECT_C_ID = projC!.id;

    const [wu] = await db
      .insert(widgetUsers)
      .values({ projectId: PROJECT_C_ID, externalUserId: `ext-c-cross-${RUN_HEX}`, name: 'CrossC' })
      .returning({ id: widgetUsers.id });
    WIDGET_USER_C_ID = wu!.id;
  });

  afterAll(async () => {
    await db.delete(widgetUserNotifications).where(eq(widgetUserNotifications.projectId, PROJECT_C_ID));
    await db.delete(widgetUserBalances).where(eq(widgetUserBalances.projectId, PROJECT_C_ID));
    await db.delete(pointGrants).where(eq(pointGrants.projectId, PROJECT_C_ID));
    await db.delete(widgetUsers).where(eq(widgetUsers.projectId, PROJECT_C_ID));
    await db.delete(widgetProjects).where(eq(widgetProjects.id, PROJECT_C_ID));
    await db.delete(servers).where(eq(servers.id, SERVER_C_ID));
  });

  it('throws when widgetUserId belongs to a different project', async () => {
    const { service } = makeService();

    // Attempt to grant a bonus against project A's projectId but using project C's widgetUserId
    await expect(
      service.grantBonus({
        projectId: PROJECT_ID,
        widgetUserId: WIDGET_USER_C_ID,
        amount: 50,
        reason: 'Cross-tenant attack',
        clientRequestId: `cross-bonus-${randomBytes(4).toString('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'cross_tenant_user' });

    // No grant row inserted under either project
    const grantsInA = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.projectId, PROJECT_ID));
    expect(grantsInA).toHaveLength(0);

    const grantsInC = await db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.projectId, PROJECT_C_ID));
    expect(grantsInC).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// grantBonus pubsub payload includes notificationId
// ---------------------------------------------------------------------------
describe('grantBonus pubsub payload', () => {
  it('includes notificationId in the per-user notification topic', async () => {
    const { service, published } = makeService();

    await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 25,
      reason: 'Pubsub notificationId test',
      clientRequestId: `notif-id-${randomBytes(4).toString('hex')}`,
    });

    // Find the per-user notification event
    const userEvt = published.find(
      (p: any) => p.topic === `community:widget_user:${WIDGET_USER_ID}`,
    ) as any;
    expect(userEvt).toBeDefined();
    expect(userEvt.payload.type).toBe('community_notification');
    expect(typeof userEvt.payload.notificationId).toBe('string');
    expect(userEvt.payload.notificationId).toBeTruthy();

    // Verify the notificationId matches the actual inserted row
    const notifs = await db
      .select()
      .from(widgetUserNotifications)
      .where(eq(widgetUserNotifications.widgetUserId, WIDGET_USER_ID));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.id).toBe(userEvt.payload.notificationId);
  });
});

// ---------------------------------------------------------------------------
// Rank computation and tie-breaking
// ---------------------------------------------------------------------------
describe('rank tie-breaking', () => {
  it('orders by payouts_count desc when balance is equal', async () => {
    const { service } = makeService();

    // Alice: 1 auto_completion = balance 10, payoutsCount 1
    await service.awardForCompletion(
      makeEvent({ externalUserId: `ext-a-${RUN_HEX}`, upvoteCountAtTransition: 0, selfUpvoted: false }),
    );
    // Bob: 1 admin bonus = balance 10, payoutsCount 0
    await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID_B,
      amount: 10,
      reason: 'Manual',
      clientRequestId: `rb-${randomBytes(4).toString('hex')}`,
    });

    // Both have balance 10. Alice has payoutsCount=1, Bob has payoutsCount=0.
    // Alice should be rank 1 (higher payoutsCount wins tiebreak).
    const [alice, bob] = await Promise.all([
      db
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID)),
      db
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID_B)),
    ]);
    expect(alice[0]!.rank).toBeLessThan(bob[0]!.rank!);
    expect(alice[0]!.rank).toBe(1);
    expect(bob[0]!.rank).toBe(2);
  });

  it('orders by widget_users.created_at asc when balance and payoutsCount are equal', async () => {
    const { service } = makeService();

    // Give Alice and Carol each a 10-point bonus (both payoutsCount=0)
    await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID,
      amount: 10,
      reason: 'Alice bonus',
      clientRequestId: `rca-${randomBytes(4).toString('hex')}`,
    });
    await service.grantBonus({
      projectId: PROJECT_ID,
      widgetUserId: WIDGET_USER_ID_C,
      amount: 10,
      reason: 'Carol bonus',
      clientRequestId: `rcc-${randomBytes(4).toString('hex')}`,
    });

    // Alice was created before Carol (inserted first in beforeAll), so Alice should rank 1.
    const [alice, carol] = await Promise.all([
      db
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID)),
      db
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID_C)),
    ]);
    expect(alice[0]!.rank).toBe(1);
    expect(carol[0]!.rank).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// awardForStepAdvance
// ---------------------------------------------------------------------------
async function seedTicket(createdById: string): Promise<string> {
  const id = makeUUID();
  await db.insert(workspaceTasks).values({
    id,
    serverId: SERVER_ID,
    title: `step-test ${id.slice(0, 8)}`,
    sourceType: 'widget',
    createdByType: 'external',
    createdById,
  });
  return id;
}

async function seedExternalVote(ticketId: string, widgetUserId: string): Promise<void> {
  await db.insert(workspaceTaskVotes).values({
    serverId: SERVER_ID,
    taskId: ticketId,
    voterType: 'external',
    voterId: widgetUserId,
    value: true,
  });
}

describe('awardForStepAdvance', () => {
  it('grants 1 coin per crossed tier to creator and each external voter', async () => {
    const { service } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    await seedExternalVote(ticketId, WIDGET_USER_ID_B);
    await seedExternalVote(ticketId, WIDGET_USER_ID_C);

    const res = await service.awardForStepAdvance({
      ticketId, projectId: PROJECT_ID, sourceType: 'widget',
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'planned', newStatus: 'reviewed',
    });

    // 2 crossed tiers (in_progress, reviewed) x 3 recipients = 6 grants; each balance += 2.
    expect(res.applied).toBe(true);
    expect(res.grantsCreated).toBe(6);
    for (const uid of [WIDGET_USER_ID, WIDGET_USER_ID_B, WIDGET_USER_ID_C]) {
      const [bal] = await db.select().from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, uid));
      expect(bal!.balance).toBe(2);
    }
  });

  it('is idempotent: replaying the same transition creates no new grants', async () => {
    const { service } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    const ev = {
      ticketId, projectId: PROJECT_ID, sourceType: 'widget' as const,
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'planned', newStatus: 'in_progress',
    };
    const first = await service.awardForStepAdvance(ev);
    const second = await service.awardForStepAdvance(ev);
    expect(first.grantsCreated).toBe(1);
    expect(second.grantsCreated).toBe(0);
    const [bal] = await db.select().from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(bal!.balance).toBe(1);
  });

  it('a creator who also upvoted earns once per tier, tagged creator', async () => {
    const { service } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    await seedExternalVote(ticketId, WIDGET_USER_ID); // self-upvote
    const res = await service.awardForStepAdvance({
      ticketId, projectId: PROJECT_ID, sourceType: 'widget',
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'planned', newStatus: 'in_progress',
    });
    expect(res.grantsCreated).toBe(1);
    const grants = await db.select().from(pointGrants).where(eq(pointGrants.widgetUserId, WIDGET_USER_ID));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.reasonCode).toBe('creator_step');
  });

  it('multi-tier jump grants every crossed tier once', async () => {
    const { service } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    const res = await service.awardForStepAdvance({
      ticketId, projectId: PROJECT_ID, sourceType: 'widget',
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'planned', newStatus: 'deployed',
    });
    expect(res.grantsCreated).toBe(4); // in_progress, reviewed, merged, deployed
    const [bal] = await db.select().from(widgetUserBalances).where(eq(widgetUserBalances.widgetUserId, WIDGET_USER_ID));
    expect(bal!.balance).toBe(4);
  });

  it('native-source or missing project is a no-op', async () => {
    const { service } = makeService();
    const res = await service.awardForStepAdvance({
      ticketId: makeUUID(), projectId: '', sourceType: 'native',
      creatorWidgetUserId: null, oldStatus: 'planned', newStatus: 'deployed',
    });
    expect(res.applied).toBe(false);
    expect(res.grantsCreated).toBe(0);
  });

  it('backward transition grants nothing', async () => {
    const { service } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    const res = await service.awardForStepAdvance({
      ticketId, projectId: PROJECT_ID, sourceType: 'widget',
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'merged', newStatus: 'in_progress',
    });
    expect(res.applied).toBe(false);
    expect(res.grantsCreated).toBe(0);
  });

  it('publishes balance_changed + notification per touched user, post-commit', async () => {
    const { service, published } = makeService();
    const ticketId = await seedTicket(WIDGET_USER_ID);
    await seedExternalVote(ticketId, WIDGET_USER_ID_B);
    await service.awardForStepAdvance({
      ticketId, projectId: PROJECT_ID, sourceType: 'widget',
      creatorWidgetUserId: WIDGET_USER_ID, oldStatus: 'planned', newStatus: 'in_progress',
    });
    const balanceMsgs = (published as Array<{ payload: { type: string } }>).filter((p) => p.payload.type === 'community_balance_changed');
    const notifMsgs = (published as Array<{ payload: { type: string } }>).filter((p) => p.payload.type === 'community_notification');
    expect(balanceMsgs).toHaveLength(2); // creator + voter
    expect(notifMsgs).toHaveLength(2);
  });
});
