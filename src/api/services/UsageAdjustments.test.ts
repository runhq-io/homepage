import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, subscriptions, usageAdjustments, adminUsers } from '@/db';
import { applyAdjustment } from './UsageAdjustments';
import { getPeriodSpending, grantCredits } from './UsageService';
import { eq, and } from 'drizzle-orm';

describe('applyAdjustment', () => {
  const userId  = '00000000-0000-0000-0000-000000000ccc';
  const adminId = '00000000-0000-0000-0000-000000000ddd';

  beforeEach(async () => {
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, adminId));
    await db.insert(users).values([
      { id: userId,  email: 'adj-test@example.com' } as any,
      { id: adminId, email: 'admin-test@example.com' } as any,
    ]);
    // creditBalanceCents is numeric(12,4) — pass as string.
    await db.insert(subscriptions).values({
      userId, planId: 'free', status: 'active', creditBalanceCents: '10000.0000',
    } as any);
  });

  afterAll(async () => {
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, adminId));
  });

  it('a positive adjustment (charge more) reduces balance and records the row', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: 500, reason: 'correction' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    // Drizzle returns numeric(12,4) as string — cast.
    expect(Number(sub.creditBalanceCents)).toBe(9500);

    const rows = await db.select().from(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountCents)).toBe(500);
    expect(rows[0].reason).toBe('correction');
    expect(rows[0].adminUserId).toBe(adminId);
  });

  it('a negative adjustment (refund) increases balance', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: -200, reason: 'refund for outage' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(Number(sub.creditBalanceCents)).toBe(10200);
  });

  it('adjustments appear in getPeriodSpending', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: 50, reason: 'test' });
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 60_000);
    const r = await getPeriodSpending(userId, start, end);
    expect(r.totalCostCents).toBeCloseTo(50, 3);
  });

  it('preserves adjustment rows when the admin user is deleted (FK set null)', async () => {
    const tempAdmin = '00000000-0000-0000-0000-000000000eee';
    // Clean up any stale state
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    await db.delete(users).where(eq(users.id, tempAdmin));

    await db.insert(users).values({ id: tempAdmin, email: 'temp-admin@example.com' } as any);

    // applyAdjustment doesn't check admin status, so we can call it directly.
    await applyAdjustment({
      userId, adminUserId: tempAdmin, amountCents: 100, reason: 'test-admin-delete',
    });

    // Now delete the admin user — should NOT throw (was FK violation before fix).
    await db.delete(users).where(eq(users.id, tempAdmin));

    // Adjustment row should still exist with adminUserId = null
    const [row] = await db.select().from(usageAdjustments)
      .where(and(eq(usageAdjustments.userId, userId), eq(usageAdjustments.reason, 'test-admin-delete')));
    expect(row).toBeDefined();
    expect(row.adminUserId).toBeNull();
  });

  it('creates a subscription row when one does not exist (new user)', async () => {
    // Start clean — user exists but has no subscription.
    await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
    const before = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(before).toHaveLength(0);

    // Admin grants 500 cents.
    await applyAdjustment({
      userId, adminUserId: adminId, amountCents: -500, reason: 'welcome bonus',
    });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub).toBeDefined();
    // getOrCreateSubscription seeds new free-tier users with planConfig.monthlyCreditsCents (500).
    // A -500 adjustment (credit grant) applies GREATEST(0, 500 - (-500)) = 1000.
    expect(Number(sub.creditBalanceCents)).toBe(1000);

    const rows = await db.select().from(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe('grantCredits', () => {
  const u = '00000000-0000-0000-0000-000000000ccc';
  const a = '00000000-0000-0000-0000-000000000ddd';

  beforeEach(async () => {
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, u));
    await db.delete(subscriptions).where(eq(subscriptions.userId, u));
    await db.delete(adminUsers).where(eq(adminUsers.userId, a));
    await db.delete(users).where(eq(users.id, u));
    await db.delete(users).where(eq(users.id, a));
    await db.insert(users).values([
      { id: u, email: 'gc-test@example.com' } as any,
      { id: a, email: 'gc-admin@example.com' } as any,
    ]);
    // creditBalanceCents is numeric(12,4) — pass as string.
    await db.insert(subscriptions).values({
      userId: u, planId: 'free', status: 'active', creditBalanceCents: '5000.0000',
    } as any);
  });

  afterAll(async () => {
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, u));
    await db.delete(subscriptions).where(eq(subscriptions.userId, u));
    await db.delete(adminUsers).where(eq(adminUsers.userId, a));
    await db.delete(users).where(eq(users.id, u));
    await db.delete(users).where(eq(users.id, a));
  });

  it('records a usage_adjustments row (ledger invariant)', async () => {
    await db.insert(adminUsers).values({ userId: a }).onConflictDoNothing();

    const before = await db.select().from(usageAdjustments)
      .where(eq(usageAdjustments.userId, u));
    const countBefore = before.length;

    const result = await grantCredits(a, u, 1000, 'test grant');
    expect(result.success).toBe(true);

    const after = await db.select().from(usageAdjustments)
      .where(eq(usageAdjustments.userId, u));
    expect(after.length).toBe(countBefore + 1);

    // Cleanup admin row
    await db.delete(adminUsers).where(eq(adminUsers.userId, a));
  });
});
