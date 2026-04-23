import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, usageEvents, usageAdjustments } from '@/db';
import {
  getDailyTotals,
  getSummary,
  getBreakdownByUser,
  getBreakdownByServer,
  getBreakdownByTask,
  getBreakdownByAgent,
  getBreakdownByJob,
} from './UsageReportService';
import { inArray } from 'drizzle-orm';

describe('UsageReportService', () => {
  const u1 = '00000000-0000-0000-0000-000000000e01';
  const u2 = '00000000-0000-0000-0000-000000000e02';
  const adminId = '00000000-0000-0000-0000-000000000e03';

  const filter = {
    start: new Date('2026-04-01T00:00:00Z'),
    end:   new Date('2026-05-01T00:00:00Z'),
  };

  beforeEach(async () => {
    await db.delete(usageAdjustments).where(inArray(usageAdjustments.userId, [u1, u2]));
    await db.delete(usageEvents).where(inArray(usageEvents.userId, [u1, u2]));
    await db.delete(users).where(inArray(users.id, [u1, u2, adminId]));
    await db.insert(users).values([
      { id: u1, email: 'r1@example.com' },
      { id: u2, email: 'r2@example.com' },
      { id: adminId, email: 'ra@example.com' },
    ] as any);

    await db.insert(usageEvents).values([
      { userId: u1, ts: new Date('2026-04-10T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: 's1', taskId: 't1', taskLabel: 'Task One',
        jobId: 'job-1',
        agentId: 'a1', agentLabel: 'Agent One',
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '10.0000' },
      { userId: u1, ts: new Date('2026-04-12T12:00:00Z'), model: 'claude-opus-4-7',
        serverId: 's1', taskId: 't1', taskLabel: 'Task One',
        jobId: 'job-1',
        agentId: 'a2', agentLabel: 'Agent Two',
        inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '30.0000' },
      { userId: u2, ts: new Date('2026-04-15T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: 's2', taskId: null, taskLabel: null,
        jobId: 'job-2',
        agentId: null, agentLabel: null,
        inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '5.0000' },
      // A pre-cutover rollup row
      { userId: u1, ts: new Date('2026-04-30T23:59:59Z'), model: 'pre-cutover-rollup',
        jobId: null,
        inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '100.0000' },
    ] as any);
  });

  afterAll(async () => {
    await db.delete(usageAdjustments).where(inArray(usageAdjustments.userId, [u1, u2]));
    await db.delete(usageEvents).where(inArray(usageEvents.userId, [u1, u2]));
    await db.delete(users).where(inArray(users.id, [u1, u2, adminId]));
  });

  it('getSummary totals rows in range for seeded users', async () => {
    const s = await getSummary({ ...filter, userIds: [u1, u2] });
    // 10 + 30 + 5 + 100 = 145
    expect(s.totalCostCents).toBeCloseTo(145, 3);
    expect(s.requestCount).toBe(4);
    expect(s.distinctUsers).toBe(2);
    expect(s.distinctServers).toBe(2);   // s1, s2 (null excluded by COUNT DISTINCT)
  });

  it('getSummary excludes pre-cutover when requested', async () => {
    const s = await getSummary({ ...filter, userIds: [u1, u2], excludePreCutover: true });
    expect(s.totalCostCents).toBeCloseTo(45, 3);  // 10 + 30 + 5
    expect(s.requestCount).toBe(3);
  });

  it('getDailyTotals buckets by day', async () => {
    const rows = await getDailyTotals({ ...filter, userIds: [u1, u2], excludePreCutover: true }, 'day');
    // 2026-04-10: $10, 2026-04-12: $30, 2026-04-15: $5
    expect(rows).toHaveLength(3);
    const byDay = Object.fromEntries(rows.map((r) => [r.bucket, r.totalCostCents]));
    expect(byDay['2026-04-10']).toBeCloseTo(10, 3);
    expect(byDay['2026-04-12']).toBeCloseTo(30, 3);
    expect(byDay['2026-04-15']).toBeCloseTo(5, 3);
  });

  it('getBreakdownByUser groups + sorts desc', async () => {
    const rows = await getBreakdownByUser({ ...filter, userIds: [u1, u2], excludePreCutover: true });
    expect(rows[0].userId).toBe(u1);          // u1 spent $40
    expect(rows[0].totalCostCents).toBeCloseTo(40, 3);
    expect(rows[1].userId).toBe(u2);
    expect(rows[1].totalCostCents).toBeCloseTo(5, 3);
  });

  it('getBreakdownByServer groups by serverId', async () => {
    const rows = await getBreakdownByServer({ ...filter, userIds: [u1, u2], excludePreCutover: true });
    const byServer = Object.fromEntries(rows.map((r) => [r.serverId ?? '__null', r.totalCostCents]));
    expect(byServer.s1).toBeCloseTo(40, 3);
    expect(byServer.s2).toBeCloseTo(5, 3);
  });

  it('getBreakdownByTask uses taskLabel when present', async () => {
    const rows = await getBreakdownByTask({ ...filter, userIds: [u1, u2] });
    const taskOne = rows.find((r) => r.taskId === 't1');
    expect(taskOne?.taskLabel).toBe('Task One');
    expect(taskOne?.totalCostCents).toBeCloseTo(40, 3);
  });

  it('getBreakdownByAgent groups by agentId', async () => {
    const rows = await getBreakdownByAgent({ ...filter, userIds: [u1, u2] });
    const byAgent = Object.fromEntries(rows.map((r) => [r.agentId ?? '__null', r.totalCostCents]));
    expect(byAgent.a1).toBeCloseTo(10, 3);
    expect(byAgent.a2).toBeCloseTo(30, 3);
  });

  it('getBreakdownByJob groups by jobId and excludes nulls from links', async () => {
    const rows = await getBreakdownByJob({ ...filter, userIds: [u1, u2], excludePreCutover: true });
    const byJob = Object.fromEntries(rows.map((r) => [r.jobId ?? '__null', r.totalCostCents]));
    // job-1: 10 + 30 = 40, job-2: 5
    expect(byJob['job-1']).toBeCloseTo(40, 3);
    expect(byJob['job-2']).toBeCloseTo(5, 3);
  });
});
