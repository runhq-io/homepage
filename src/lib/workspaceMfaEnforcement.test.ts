import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => {
  const select = vi.fn();
  return {
    db: { select },
    users: {},
    organizations: {},
    organizationMembers: {},
  };
});

import { db } from '@/db';
import { computeMfaEnforcement, MFA_GRACE_PERIOD_MS } from './workspaceMfaEnforcement';

beforeEach(() => vi.clearAllMocks());

function mockSelects(userRow: any, orgRows: any[]) {
  let call = 0;
  (db.select as any).mockImplementation(() => {
    call++;
    const rows = call === 1 ? [userRow] : orgRows;
    return {
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
        innerJoin: () => ({ where: () => Promise.resolve(rows) }),
      }),
    };
  });
}

describe('computeMfaEnforcement', () => {
  it('returns ok when user has MFA', async () => {
    mockSelects({ mfaEnabled: true }, []);
    expect(await computeMfaEnforcement('u1')).toEqual({ status: 'ok' });
  });

  it('returns ok when user has no enforcing workspaces', async () => {
    mockSelects({ mfaEnabled: false }, []);
    expect(await computeMfaEnforcement('u1')).toEqual({ status: 'ok' });
  });

  it('returns grace when enforced recently', async () => {
    const enforcedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    mockSelects({ mfaEnabled: false }, [
      { orgId: 'o1', name: 'Workspace A', requireMfa: true, enforcedAt },
    ]);
    const state = await computeMfaEnforcement('u1');
    expect(state.status).toBe('grace');
    expect(state.workspaceId).toBe('o1');
    expect(state.workspaceName).toBe('Workspace A');
    expect(state.deadline!.getTime()).toBeCloseTo(enforcedAt.getTime() + MFA_GRACE_PERIOD_MS, -2);
  });

  it('returns required when past grace', async () => {
    const enforcedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    mockSelects({ mfaEnabled: false }, [
      { orgId: 'o1', name: 'Workspace A', requireMfa: true, enforcedAt },
    ]);
    const state = await computeMfaEnforcement('u1');
    expect(state.status).toBe('required');
  });

  it('picks earliest deadline across multiple workspaces', async () => {
    mockSelects({ mfaEnabled: false }, [
      { orgId: 'o1', name: 'A', requireMfa: true, enforcedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) },
      { orgId: 'o2', name: 'B', requireMfa: true, enforcedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
    ]);
    const state = await computeMfaEnforcement('u1');
    expect(state.workspaceId).toBe('o1');
  });
});
