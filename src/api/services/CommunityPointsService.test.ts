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
    expect(communityEvt.payload.type).toBe('balance_changed');
    expect(communityEvt.payload.widgetUserId).toBe(WIDGET_USER_ID);
    expect(typeof communityEvt.payload.oldBalance).toBe('number');
    expect(typeof communityEvt.payload.newBalance).toBe('number');
    expect(communityEvt.payload.newBalance).toBe(12);

    const userEvt = published.find(
      (p: any) => p.topic === `community:widget_user:${WIDGET_USER_ID}`,
    ) as any;
    expect(userEvt).toBeDefined();
    expect(userEvt.payload.type).toBe('notification');
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
    expect(communityEvt.payload.type).toBe('balance_changed');
    const userEvt = published.find(
      (p: any) => p.topic === `community:widget_user:${WIDGET_USER_ID}`,
    ) as any;
    expect(userEvt).toBeDefined();
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
    ).rejects.toThrow('Cannot reverse a reversal grant');
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
    ).rejects.toThrow('Grant not found');
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
