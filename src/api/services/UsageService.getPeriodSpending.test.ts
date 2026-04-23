import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, subscriptions, usageEvents, usageAdjustments } from '@/db';
import { getPeriodSpending } from './UsageService';
import { eq } from 'drizzle-orm';

// INTEGRATION test: hits the real dev DB via DATABASE_URL.

describe('getPeriodSpending', () => {
  const testUserId = '00000000-0000-0000-0000-000000000aaa';
  const start = new Date('2026-04-01T00:00:00Z');
  const end   = new Date('2026-05-01T00:00:00Z');

  beforeEach(async () => {
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
    await db.insert(users).values({ id: testUserId, email: 'gp-test@example.com' } as any);
  });

  afterAll(async () => {
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(usageAdjustments).where(eq(usageAdjustments.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it('returns zeros when no events exist', async () => {
    const r = await getPeriodSpending(testUserId, start, end);
    expect(r).toEqual({
      inputTokens: 0, outputTokens: 0, totalCostCents: 0, requestCount: 0,
    });
  });

  it('sums events within the period', async () => {
    await db.insert(usageEvents).values([
      {
        userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),
        model: 'claude-sonnet-4-6',
        inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.5000',
      },
      {
        userId: testUserId, ts: new Date('2026-04-20T12:00:00Z'),
        model: 'claude-sonnet-4-6',
        inputTokens: 2000, outputTokens: 1000,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '21.0000',
      },
    ]);

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.inputTokens).toBe(3000);
    expect(r.outputTokens).toBe(1500);
    expect(r.totalCostCents).toBeCloseTo(31.5, 3);
    expect(r.requestCount).toBe(2);
  });

  it('excludes events outside the period', async () => {
    await db.insert(usageEvents).values([
      {
        userId: testUserId, ts: new Date('2026-03-31T23:59:59Z'),  // before start
        model: 'claude-sonnet-4-6',
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '1.0000',
      },
      {
        userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),  // in
        model: 'claude-sonnet-4-6',
        inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.0000',
      },
      {
        userId: testUserId, ts: new Date('2026-05-01T00:00:01Z'),  // after end
        model: 'claude-sonnet-4-6',
        inputTokens: 500, outputTokens: 250,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '5.0000',
      },
    ]);

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.requestCount).toBe(1);
    expect(r.totalCostCents).toBeCloseTo(10, 3);
  });

  it('sums usage_adjustments alongside events', async () => {
    await db.insert(usageEvents).values({
      userId: testUserId, ts: new Date('2026-04-10T12:00:00Z'),
      model: 'claude-sonnet-4-6',
      inputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      costCents: '10.0000',
    });
    await db.insert(usageAdjustments).values({
      userId: testUserId, adminUserId: testUserId,  // self-adjust just for test
      ts: new Date('2026-04-15T12:00:00Z'),
      amountCents: '-2.5000',  // refund
      reason: 'test refund',
    });

    const r = await getPeriodSpending(testUserId, start, end);
    expect(r.totalCostCents).toBeCloseTo(7.5, 3);
    expect(r.requestCount).toBe(1); // adjustments don't count as requests
  });
});
