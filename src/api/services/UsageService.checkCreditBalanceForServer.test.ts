import 'dotenv/config';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, users, subscriptions, servers } from '@/db';
import { checkCreditBalanceForServer } from './UsageService';
import { eq } from 'drizzle-orm';

/**
 * Regression test for the screening-gate billing bug: the status-update
 * screening proxy authenticates with the workspace SERVER_TOKEN, which carries
 * no user. checkCreditBalanceForServer must bill the SERVER OWNER (resolved from
 * serverId) rather than reporting "no subscription" just because the token has
 * no embedded user.
 */
describe('checkCreditBalanceForServer — bills the resolved server owner', () => {
  const ownerId = '00000000-0000-0000-0000-0000000c0de0';
  const serverId = 'ws_creditcheck_test';
  // An opaque, non-user server token (no JWT/base64-json/UUID structure) —
  // mirrors the real workspace SERVER_TOKEN shape.
  const opaqueServerToken = 'serverTok_aaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(async () => {
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.insert(users).values({ id: ownerId, email: 'creditcheck-owner@example.com' } as any);
  });

  afterAll(async () => {
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
  });

  async function giveOwner(planId: string, status: string, balanceCents: string) {
    await db.insert(subscriptions).values({ userId: ownerId, planId, status, creditBalanceCents: balanceCents } as any);
  }
  async function makeServer() {
    await db.insert(servers).values({ id: serverId, name: 'test', ownerId, provider: 'fly' } as any);
  }

  it('ALLOWS an opaque server token when the resolved owner has an active, funded subscription', async () => {
    await giveOwner('starter', 'active', '50000.0000');
    await makeServer();

    const result = await checkCreditBalanceForServer(opaqueServerToken, serverId);

    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('starter');
  });

  it('BLOCKS an opaque server token when the resolved owner is out of credits', async () => {
    await giveOwner('starter', 'active', '0.0000');
    await makeServer();

    const result = await checkCreditBalanceForServer(opaqueServerToken, serverId);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('insufficient_credits');
  });

  it('returns no_subscription only when neither the server owner nor the token resolves a user', async () => {
    // No server row inserted → owner unresolvable; opaque token → no actor user.
    const result = await checkCreditBalanceForServer(opaqueServerToken, 'ws_does_not_exist');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_subscription');
  });
});
