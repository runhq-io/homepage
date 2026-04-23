import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, subscriptions, usageEvents } from '@/db';
import { trackUsage } from './UsageService';
import { eq } from 'drizzle-orm';

describe('trackUsage', () => {
  const testUserId = '00000000-0000-0000-0000-000000000bbb';

  beforeEach(async () => {
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
    await db.insert(users).values({ id: testUserId, email: 'track-test@example.com' } as any);
    await db.insert(subscriptions).values({
      userId: testUserId, planId: 'free', status: 'active', creditBalanceCents: 10000,
    } as any);
  });

  afterAll(async () => {
    await db.delete(usageEvents).where(eq(usageEvents.userId, testUserId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  it('inserts an event and deducts balance atomically', async () => {
    await trackUsage({
      userId: testUserId,
      model: 'claude-sonnet-4-6',
      tokens: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costCents: 10.5,  // sub-cent precision
      context: { serverId: 'test-server-1', taskId: null, taskLabel: null,
                 channelId: null, channelLabel: null, agentId: null, agentLabel: null,
                 conversationId: null },
      anthropicRequestId: 'req_test_123',
    });

    const events = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe('claude-sonnet-4-6');
    expect(events[0].serverId).toBe('test-server-1');
    expect(Number(events[0].costCents)).toBeCloseTo(10.5, 3);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, testUserId));
    // 10000 cents - 10.5 cents = 9989.5; subscriptions.credit_balance_cents is integer,
    // so balance is rounded to the nearest whole cent before writing: Math.round(10.5) = 11.
    // 10000 - 11 = 9989.
    expect(sub.creditBalanceCents).toBe(9989);
  });

  it('clamps balance at 0 (does not go negative)', async () => {
    await db.update(subscriptions)
      .set({ creditBalanceCents: 5 })
      .where(eq(subscriptions.userId, testUserId));

    await trackUsage({
      userId: testUserId,
      model: 'claude-sonnet-4-6',
      tokens: { inputTokens: 10_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costCents: 3000,  // way over balance
      context: { serverId: null, taskId: null, taskLabel: null,
                 channelId: null, channelLabel: null, agentId: null, agentLabel: null,
                 conversationId: null },
      anthropicRequestId: null,
    });

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, testUserId));
    expect(sub.creditBalanceCents).toBe(0);
    // Event is still written even when balance was insufficient — we already called Anthropic.
    const events = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(events).toHaveLength(1);
    expect(Number(events[0].costCents)).toBeCloseTo(3000, 3);
  });

  it('persists all context fields', async () => {
    await trackUsage({
      userId: testUserId,
      model: 'claude-opus-4-7',
      tokens: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 30 },
      costCents: 1.234,
      context: {
        serverId: 'fly-machine-abc',
        taskId: 'task-1',     taskLabel: 'Fix login bug',
        channelId: 'chan-1',  channelLabel: '#engineering',
        agentId: 'agent-1',   agentLabel: 'QA Bot',
        conversationId: 'conv-1',
      },
      anthropicRequestId: 'req_xyz',
    });

    const [e] = await db.select().from(usageEvents).where(eq(usageEvents.userId, testUserId));
    expect(e.serverId).toBe('fly-machine-abc');
    expect(e.taskId).toBe('task-1');
    expect(e.taskLabel).toBe('Fix login bug');
    expect(e.channelId).toBe('chan-1');
    expect(e.channelLabel).toBe('#engineering');
    expect(e.agentId).toBe('agent-1');
    expect(e.agentLabel).toBe('QA Bot');
    expect(e.conversationId).toBe('conv-1');
    expect(e.anthropicRequestId).toBe('req_xyz');
    expect(e.cacheReadTokens).toBe(50);
    expect(e.cacheCreationTokens).toBe(30);
  });
});
