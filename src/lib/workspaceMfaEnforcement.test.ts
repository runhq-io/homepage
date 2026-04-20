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
import { computeMfaEnforcement, enforceMfaOrRespond, getMfaGracePeriodMs } from './workspaceMfaEnforcement';

// Pin grace period to 7 days for the test suite so the math stays stable
// regardless of the deployed env's MFA_GRACE_PERIOD_DAYS setting.
beforeEach(() => {
  process.env.MFA_GRACE_PERIOD_DAYS = '7';
  vi.clearAllMocks();
});

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
    expect(state.deadline!.getTime()).toBeCloseTo(enforcedAt.getTime() + getMfaGracePeriodMs(), -2);
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

describe('enforceMfaOrRespond', () => {
  it('returns null when ok', async () => {
    mockSelects({ mfaEnabled: true }, []);
    expect(await enforceMfaOrRespond('u1')).toBeNull();
  });

  it('returns null when in grace period', async () => {
    mockSelects({ mfaEnabled: false }, [
      { orgId: 'o1', name: 'A', requireMfa: true, enforcedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
    ]);
    expect(await enforceMfaOrRespond('u1')).toBeNull();
  });

  it('returns 403 MFA_REQUIRED when past grace', async () => {
    mockSelects({ mfaEnabled: false }, [
      { orgId: 'o1', name: 'A', requireMfa: true, enforcedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    ]);
    const res = await enforceMfaOrRespond('u1');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toBe('MFA_REQUIRED');
    expect(body.workspaceId).toBe('o1');
  });
});
