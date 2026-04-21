/**
 * Tests for admin server CRUD operations (actions.ts).
 *
 * The DB-level cleanup mechanics (which child tables are deleted, transaction
 * atomicity, completeness vs. schema) live inside
 * `deleteServersAndDependents` and are covered by
 * `ServerService.cascade.test.ts`. This file only verifies the admin-facing
 * contract: auth gating, early-return, and that the helper is invoked with
 * the expected IDs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/api/services/ServerService', () => ({
  deleteServersAndDependents: vi.fn(async () => {}),
}));

vi.mock('@/lib/fly-api', () => ({
  destroyFlyMachine: vi.fn(async () => {}),
}));

vi.mock('@/db', () => {
  const servers = { _name: 'servers', id: 'id', machineId: 'machine_id' };
  return {
    servers,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      })),
    },
  };
});

import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { deleteServersAndDependents } from '@/api/services/ServerService';
import { deleteServers } from './actions';

describe('Admin Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockAdminSession() {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', name: 'Admin', isAdmin: true },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);
  }

  function mockNonAdminSession() {
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', name: 'User', isAdmin: false },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);
  }

  function mockUnauthenticated() {
    vi.mocked(auth).mockResolvedValue(null as any);
  }

  describe('deleteServers', () => {
    it('delegates to deleteServersAndDependents with the provided ids', async () => {
      mockAdminSession();

      const result = await deleteServers(['ws-1', 'ws-2']);

      expect(result).toEqual({ success: true, count: 2 });
      expect(deleteServersAndDependents).toHaveBeenCalledTimes(1);
      expect(deleteServersAndDependents).toHaveBeenCalledWith(['ws-1', 'ws-2']);
    });

    it('returns early without touching the helper for an empty array', async () => {
      mockAdminSession();

      const result = await deleteServers([]);

      expect(result).toEqual({ success: true, count: 0 });
      expect(deleteServersAndDependents).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('revalidates the admin servers path after deletion', async () => {
      mockAdminSession();

      await deleteServers(['ws-1']);

      expect(revalidatePath).toHaveBeenCalledWith('/admin/servers');
    });

    it('rejects unauthenticated users without deleting anything', async () => {
      mockUnauthenticated();

      await expect(deleteServers(['ws-1'])).rejects.toThrow('Not authenticated');
      expect(deleteServersAndDependents).not.toHaveBeenCalled();
    });

    it('rejects non-admin users without deleting anything', async () => {
      mockNonAdminSession();

      await expect(deleteServers(['ws-1'])).rejects.toThrow('Not authorized');
      expect(deleteServersAndDependents).not.toHaveBeenCalled();
    });
  });
});
