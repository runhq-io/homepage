/**
 * Tests for the admin migrations action.
 *
 * The migration runner itself (snapshot, app create, restore, cutover,
 * recovery) is exhaustively covered by
 * `ServerService.metadata-durability.test.ts` and the runner's tests.
 * This file only verifies the admin-facing contract: auth gating,
 * argument validation, and that the runner is invoked with the
 * expected serverId and its result is propagated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/api/services/ServerService', () => ({
  migrateWorkspaceToOwnApp: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { migrateWorkspaceToOwnApp } from '@/api/services/ServerService';
import { migrateOne } from './actions';

describe('admin migrations actions', () => {
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

  describe('migrateOne', () => {
    it('delegates to migrateWorkspaceToOwnApp and returns its result', async () => {
      mockAdminSession();
      const fakeResult = {
        serverId: 'ws_test',
        oldAppName: 'fishtank-workspaces',
        newAppName: 'ws-test',
        oldMachineId: 'mach_old',
        newMachineId: 'mach_new',
        oldVolumeId: 'vol_old',
        newVolumeId: 'vol_new',
        snapshotId: 'snap_x',
        durationMs: 158324,
      };
      vi.mocked(migrateWorkspaceToOwnApp).mockResolvedValueOnce(fakeResult);

      const result = await migrateOne('ws_test');

      expect(result).toEqual(fakeResult);
      expect(migrateWorkspaceToOwnApp).toHaveBeenCalledTimes(1);
      expect(migrateWorkspaceToOwnApp).toHaveBeenCalledWith('ws_test');
    });

    it('revalidates both /admin/migrations and /admin/servers after success', async () => {
      mockAdminSession();
      vi.mocked(migrateWorkspaceToOwnApp).mockResolvedValueOnce({
        serverId: 'ws_test',
        oldAppName: 'fishtank-workspaces',
        newAppName: 'ws-test',
        oldMachineId: 'mach_old',
        newMachineId: 'mach_new',
        oldVolumeId: 'vol_old',
        newVolumeId: 'vol_new',
        snapshotId: 'snap_x',
        durationMs: 1,
      });

      await migrateOne('ws_test');

      // Both pages may show the row; both must refetch.
      expect(revalidatePath).toHaveBeenCalledWith('/admin/migrations');
      expect(revalidatePath).toHaveBeenCalledWith('/admin/servers');
    });

    it('rejects unauthenticated callers without invoking the runner', async () => {
      mockUnauthenticated();

      await expect(migrateOne('ws_test')).rejects.toThrow('Not authenticated');
      expect(migrateWorkspaceToOwnApp).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('rejects non-admin sessions without invoking the runner', async () => {
      mockNonAdminSession();

      await expect(migrateOne('ws_test')).rejects.toThrow('Not authorized');
      expect(migrateWorkspaceToOwnApp).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('rejects an empty serverId without invoking the runner', async () => {
      mockAdminSession();

      await expect(migrateOne('')).rejects.toThrow('serverId is required');
      expect(migrateWorkspaceToOwnApp).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('propagates errors from the runner without revalidating', async () => {
      mockAdminSession();
      vi.mocked(migrateWorkspaceToOwnApp).mockRejectedValueOnce(
        new Error('Server ws_test is already on per-tenant app ws-test; nothing to migrate'),
      );

      await expect(migrateOne('ws_test')).rejects.toThrow(/already on per-tenant app/);
      // No revalidate on failure — the page is unchanged so no need to bust
      // the cache.
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });
});
