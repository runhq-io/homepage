/**
 * rebuildRemoteServer access gate.
 *
 * `rebuildRemoteServer` tears down + reprovisions a server's machine, so it must
 * be owner/admin-gated (it goes through `checkCloudOpPermission`). This locks the
 * "non-owner is denied" invariant. The happy-path reprovision is verified
 * end-to-end on a real machine (it depends on the provider + a full reprovision
 * pipeline that isn't meaningfully unit-mockable).
 *
 * Runs with no database: the db select chain is mocked to report no membership
 * and no owner match, so the permission check fails.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/workspaceMfaEnforcement', () => ({
  computeMfaEnforcement: vi.fn(async () => ({ status: 'none' })),
}));

// No membership row, and no owner match → checkCloudOpPermission returns false.
vi.mock('../../db/index', () => {
  const terminal = () => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => []), // serverMembers: none; servers(ownerId): none
    })),
  });
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => terminal()) })),
      // update should never be reached when access is denied.
      update: vi.fn(() => {
        throw new Error('db.update must not run when access is denied');
      }),
    },
  };
});

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../db/services', () => ({ getUserByEmail: vi.fn() }));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(() => ({})), and: vi.fn(() => ({})) };
});

import { rebuildRemoteServer } from './ServerService';

describe('rebuildRemoteServer — access gate', () => {
  it('denies a caller who is neither owner nor admin (and never touches the machine)', async () => {
    const result = await rebuildRemoteServer('ws_test', 'not_the_owner');
    expect(result).toEqual({ success: false, error: 'Access denied' });
  });
});
