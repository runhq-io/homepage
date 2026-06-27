import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, servers, usageEvents } from '@/db';
import { getBreakdownByServer, getBreakdownByTask, getSummary } from './UsageReportService';
import { inArray } from 'drizzle-orm';

/**
 * Regression for "billed for a server I don't own" (jaeyun, 2026-05-30).
 *
 * Before owner-pays (live 2026-05-27) usage was actor-billed: whoever ran the
 * agent paid, even on a server they did not own. Those legacy rows have
 * usageEvents.userId = the actor but point at a server owned by someone else.
 * The per-user billing report must NEVER surface such a server. The `ownedBy`
 * filter enforces that by restricting to servers the viewer currently owns.
 */
describe('UsageReportService — ownedBy filter (per-user report scoping)', () => {
  const owner = '00000000-0000-0000-0000-000000000f01';
  const other = '00000000-0000-0000-0000-000000000f02';
  const sOwned = 'ws_test_owned_aaa';
  const sOther = 'ws_test_other_bbb';

  const filter = {
    start: new Date('2026-05-01T00:00:00Z'),
    end:   new Date('2026-06-01T00:00:00Z'),
  };

  beforeEach(async () => {
    await db.delete(usageEvents).where(inArray(usageEvents.userId, [owner, other]));
    await db.delete(servers).where(inArray(servers.id, [sOwned, sOther]));
    await db.delete(users).where(inArray(users.id, [owner, other]));

    await db.insert(users).values([
      { id: owner, email: 'owner@example.com' },
      { id: other, email: 'other@example.com' },
    ] as any);

    await db.insert(servers).values([
      { id: sOwned, name: 'My Server',    ownerId: owner },
      { id: sOther, name: 'Their Server', ownerId: other },
    ] as any);

    await db.insert(usageEvents).values([
      // Legit: billed to owner, on owner's server.
      { userId: owner, ts: new Date('2026-05-10T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: sOwned, taskId: 'tk-own', taskLabel: 'Mine',
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '40.0000' },
      // The bug: billed to owner (actor), but on a server owned by someone else.
      { userId: owner, ts: new Date('2026-05-11T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: sOther, taskId: 'tk-leak', taskLabel: 'Not Mine',
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '9.0000' },
      // Edge: billed to owner, no resolvable server (legacy, serverId null).
      { userId: owner, ts: new Date('2026-05-12T12:00:00Z'), model: 'claude-sonnet-4-6',
        serverId: null, taskId: 'tk-nosrv', taskLabel: 'No Server',
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0,
        costCents: '3.0000' },
    ] as any);
  });

  afterAll(async () => {
    await db.delete(usageEvents).where(inArray(usageEvents.userId, [owner, other]));
    await db.delete(servers).where(inArray(servers.id, [sOwned, sOther]));
    await db.delete(users).where(inArray(users.id, [owner, other]));
  });

  it('WITHOUT ownedBy, the non-owned server leaks into the report (documents the bug)', async () => {
    const rows = await getBreakdownByServer({ ...filter, userIds: [owner] });
    const ids = rows.map((r) => r.serverId);
    expect(ids).toContain(sOwned);
    expect(ids).toContain(sOther);   // <-- the leak
  });

  it('WITH ownedBy, only servers the viewer owns appear', async () => {
    const rows = await getBreakdownByServer({ ...filter, userIds: [owner], ownedBy: owner });
    const ids = rows.map((r) => r.serverId);
    expect(ids).toEqual([sOwned]);
    expect(ids).not.toContain(sOther);          // non-owned server dropped
    expect(ids).not.toContain(null);            // null/unresolvable server dropped
    const owned = rows.find((r) => r.serverId === sOwned);
    expect(owned?.totalCostCents).toBeCloseTo(40, 3);
  });

  it('ownedBy also scopes the by-task breakdown', async () => {
    const rows = await getBreakdownByTask({ ...filter, userIds: [owner], ownedBy: owner });
    const taskIds = rows.map((r) => r.taskId);
    expect(taskIds).toContain('tk-own');
    expect(taskIds).not.toContain('tk-leak');   // task on the non-owned server is gone
    expect(taskIds).not.toContain('tk-nosrv');  // task with no server is gone
  });

  it('ownedBy totals exclude the non-owned + no-server spend', async () => {
    const all = await getSummary({ ...filter, userIds: [owner] });
    expect(all.totalCostCents).toBeCloseTo(52, 3);          // 40 + 9 + 3

    const scoped = await getSummary({ ...filter, userIds: [owner], ownedBy: owner });
    expect(scoped.totalCostCents).toBeCloseTo(40, 3);       // only the owned-server spend
  });
});
