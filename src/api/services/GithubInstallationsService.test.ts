import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
vi.mock('../../db/index', () => {
  return {
    db: {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => ({
          onConflictDoUpdate: vi.fn(async (c: any) => { calls.push({ op: 'upsert', v, c }); }),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(async () => { calls.push({ op: 'delete' }); }) })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ installationId: 1, serverId: 'ws_a' }]),
        })),
      })),
    },
  };
});

import { upsertInstallation, removeInstallation, listInstallationsForServer, getInstallation } from './GithubInstallationsService.js';

describe('GithubInstallationsService', () => {
  beforeEach(() => { calls.length = 0; });

  it('upsert writes values with an onConflictDoUpdate', async () => {
    await upsertInstallation({
      installationId: 42, serverId: 'ws_a', accountLogin: 'octo', accountType: 'Organization', repositorySelection: 'all',
    });
    expect(calls[0].op).toBe('upsert');
    expect(calls[0].v.installationId).toBe(42);
  });

  it('remove issues a delete', async () => {
    await removeInstallation(42);
    expect(calls.some((c) => c.op === 'delete')).toBe(true);
  });

  it('listInstallationsForServer returns rows', async () => {
    const rows = await listInstallationsForServer('ws_a');
    expect(rows[0].serverId).toBe('ws_a');
  });

  it('getInstallation returns the first row', async () => {
    const row = await getInstallation(1);
    expect(row?.installationId).toBe(1);
  });
});
