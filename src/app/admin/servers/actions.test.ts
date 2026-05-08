/**
 * Tests for admin server CRUD operations (actions.ts).
 *
 * The DB-level cleanup mechanics (which child tables are deleted, transaction
 * atomicity, completeness vs. schema) live inside `deleteServersAndDependents`
 * and are covered by `ServerService.cascade.test.ts`. The full per-server
 * teardown (snapshot → machine → volume → Fly app → CF cleanup → DB) lives in
 * `adminDeleteServer` / `deleteServer`. This file only verifies the
 * admin-facing contract: auth gating, early-return, and that the right helper
 * is invoked with the expected arguments.
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
  adminDeleteServer: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/api/services/FlyService', () => ({
  deleteApp: vi.fn(async () => {}),
}));

import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import {
  deleteServersAndDependents,
  adminDeleteServer,
} from '@/api/services/ServerService';
import { deleteApp as flyDeleteApp } from '@/api/services/FlyService';
import { deleteServers, destroyInfra } from './actions';

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

  describe('destroyInfra', () => {
    it('returns early without touching helpers for an empty array', async () => {
      mockAdminSession();

      const result = await destroyInfra([]);

      expect(result).toEqual({ success: true, destroyed: 0, errors: [] });
      expect(adminDeleteServer).not.toHaveBeenCalled();
      expect(flyDeleteApp).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('routes targets with a dbServerId through adminDeleteServer (full teardown)', async () => {
      mockAdminSession();

      const result = await destroyInfra([
        { flyAppName: 'ws-aaa', dbServerId: 'srv-aaa' },
        { flyAppName: 'ws-bbb', dbServerId: 'srv-bbb' },
      ]);

      expect(result).toEqual({ success: true, destroyed: 2, errors: [] });
      expect(adminDeleteServer).toHaveBeenCalledTimes(2);
      expect(adminDeleteServer).toHaveBeenNthCalledWith(1, 'srv-aaa');
      expect(adminDeleteServer).toHaveBeenNthCalledWith(2, 'srv-bbb');
      expect(flyDeleteApp).not.toHaveBeenCalled();
    });

    it('routes orphan targets (no dbServerId) through FlyService.deleteApp', async () => {
      mockAdminSession();

      const result = await destroyInfra([
        { flyAppName: 'ws-orphan-1' },
        { flyAppName: 'ws-orphan-2' },
      ]);

      expect(result).toEqual({ success: true, destroyed: 2, errors: [] });
      expect(flyDeleteApp).toHaveBeenCalledTimes(2);
      expect(flyDeleteApp).toHaveBeenNthCalledWith(1, 'ws-orphan-1');
      expect(flyDeleteApp).toHaveBeenNthCalledWith(2, 'ws-orphan-2');
      expect(adminDeleteServer).not.toHaveBeenCalled();
    });

    it('collects per-target errors without aborting the rest of the batch', async () => {
      mockAdminSession();
      vi.mocked(adminDeleteServer)
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Failed to delete cloud resources' });
      vi.mocked(flyDeleteApp).mockRejectedValueOnce(new Error('Fly.io API error: 502'));

      const result = await destroyInfra([
        { flyAppName: 'ws-good', dbServerId: 'srv-good' },
        { flyAppName: 'ws-bad-db', dbServerId: 'srv-bad' },
        { flyAppName: 'ws-bad-fly' },
      ]);

      expect(result.destroyed).toBe(1);
      expect(result.success).toBe(false);
      expect(result.errors).toEqual([
        'ws-bad-db: Failed to delete cloud resources',
        'ws-bad-fly: Fly.io API error: 502',
      ]);
    });

    it('rejects unauthenticated users without touching any helper', async () => {
      mockUnauthenticated();

      await expect(destroyInfra([{ flyAppName: 'ws-x' }])).rejects.toThrow('Not authenticated');
      expect(adminDeleteServer).not.toHaveBeenCalled();
      expect(flyDeleteApp).not.toHaveBeenCalled();
    });

    it('rejects non-admin users without touching any helper', async () => {
      mockNonAdminSession();

      await expect(destroyInfra([{ flyAppName: 'ws-x' }])).rejects.toThrow('Not authorized');
      expect(adminDeleteServer).not.toHaveBeenCalled();
      expect(flyDeleteApp).not.toHaveBeenCalled();
    });
  });
});
