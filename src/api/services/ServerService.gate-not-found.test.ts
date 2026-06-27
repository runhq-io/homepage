/**
 * Access-gate not-found vs forbidden semantics.
 *
 * Regression test for the "deleted server → dead-end Forbidden screen" bug
 * (2026-05-17). Server deletion hard-deletes both the `servers` row and all
 * `server_members` rows in one transaction, so after deletion the access gate
 * sees neither a membership nor an owner row. It used to return 403 Forbidden
 * for that case — indistinguishable from a genuine authorization denial — so
 * the client could only show a useless "Try again" loop on a permanently dead
 * URL.
 *
 * Invariant locked here: when membership/ownership fails, `gateServerAccess`
 * (and `gateServerEdit`) must return:
 *   - 404 { error: 'Server not found' }  when the server row is gone
 *   - 403 { error: 'Forbidden' }         when the row exists but caller isn't a member
 *
 * Runs with no database: the db select chain is mocked per-table/projection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// computeMfaEnforcement must not short-circuit the gate.
vi.mock('@/lib/workspaceMfaEnforcement', () => ({
  computeMfaEnforcement: vi.fn(async () => ({ status: 'none' })),
}));

// Scenario toggled per test: does the `servers` row still exist?
let serverRowExists = false;

vi.mock('../../db/index', () => {
  const terminal = (projection: Record<string, unknown> | undefined, tableTag: string) => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => {
        if (tableTag === 'serverMembers') return []; // no membership row
        if (tableTag === 'servers') {
          const isExistenceCheck = !!projection && 'id' in projection;
          if (isExistenceCheck) return serverRowExists ? [{ id: 'ws_test' }] : [];
          return []; // owner fallback: caller is not the owner
        }
        return [];
      }),
    })),
  });
  return {
    db: {
      select: vi.fn((projection?: Record<string, unknown>) => ({
        from: vi.fn((table: { _t: string }) => terminal(projection, table?._t)),
      })),
    },
  };
});

// Keep the real schema (ServerService imports many tables at module load),
// just tag the two the gate touches so the db mock can branch on table.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return {
    ...actual,
    servers: { ...(actual.servers as object), _t: 'servers' },
    serverMembers: { ...(actual.serverMembers as object), _t: 'serverMembers' },
  };
});

vi.mock('../../db/services', () => ({ getUserByEmail: vi.fn() }));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(() => ({})), and: vi.fn(() => ({})) };
});

import { gateServerAccess, gateServerEdit } from './ServerService';

describe('gateServerAccess / gateServerEdit — not-found vs forbidden', () => {
  beforeEach(() => {
    serverRowExists = false;
  });

  it('returns 404 Server not found when the server row is gone (deleted)', async () => {
    serverRowExists = false;
    const gate = await gateServerAccess('ws_test', 'user_1');
    expect(gate).toEqual({ ok: false, status: 404, body: { error: 'Server not found' } });
  });

  it('returns 403 Forbidden when the server exists but caller is not a member', async () => {
    serverRowExists = true;
    const gate = await gateServerAccess('ws_test', 'user_1');
    expect(gate).toEqual({ ok: false, status: 403, body: { error: 'Forbidden' } });
  });

  it('gateServerEdit applies the same not-found vs forbidden distinction', async () => {
    serverRowExists = false;
    expect(await gateServerEdit('ws_test', 'user_1')).toEqual({
      ok: false, status: 404, body: { error: 'Server not found' },
    });

    serverRowExists = true;
    expect(await gateServerEdit('ws_test', 'user_1')).toEqual({
      ok: false, status: 403, body: { error: 'Forbidden' },
    });
  });
});
