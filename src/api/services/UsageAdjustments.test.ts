import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, subscriptions, usageAdjustments } from '@/db';
import { applyAdjustment } from './UsageAdjustments';
import { getPeriodSpending } from './UsageService';
import { eq } from 'drizzle-orm';

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
    await db.insert(subscriptions).values({
      userId, planId: 'free', status: 'active', creditBalanceCents: 10000,
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
    expect(sub.creditBalanceCents).toBe(9500);

    const rows = await db.select().from(usageAdjustments).where(eq(usageAdjustments.userId, userId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amountCents)).toBe(500);
    expect(rows[0].reason).toBe('correction');
    expect(rows[0].adminUserId).toBe(adminId);
  });

  it('a negative adjustment (refund) increases balance', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: -200, reason: 'refund for outage' });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(sub.creditBalanceCents).toBe(10200);
  });

  it('adjustments appear in getPeriodSpending', async () => {
    await applyAdjustment({ userId, adminUserId: adminId, amountCents: 50, reason: 'test' });
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 60_000);
    const r = await getPeriodSpending(userId, start, end);
    expect(r.totalCostCents).toBeCloseTo(50, 3);
  });
});
