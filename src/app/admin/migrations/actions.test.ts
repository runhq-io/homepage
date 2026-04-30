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
  createLegacyTestServer: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { migrateWorkspaceToOwnApp, createLegacyTestServer } from '@/api/services/ServerService';
import { migrateOne, createLegacyTestWorkspace } from './actions';

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

  function mockAdminSessionWithoutId() {
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'admin@test.com', name: 'Admin', isAdmin: true },
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

  describe('createLegacyTestWorkspace', () => {
    const fakeResult = {
      serverId: 'ws_abc_def',
      machineId: 'mach_test',
      serverUrl: 'https://srv-mach_test.runhq.io',
    };

    it('delegates to createLegacyTestServer with the calling admin as owner', async () => {
      mockAdminSession();
      vi.mocked(createLegacyTestServer).mockResolvedValueOnce(fakeResult);

      const result = await createLegacyTestWorkspace('migration-test');

      expect(result).toEqual(fakeResult);
      expect(createLegacyTestServer).toHaveBeenCalledTimes(1);
      // First arg = ownerId from the session, second = name (trimmed).
      expect(createLegacyTestServer).toHaveBeenCalledWith('admin-1', 'migration-test');
    });

    it('trims whitespace on the name', async () => {
      mockAdminSession();
      vi.mocked(createLegacyTestServer).mockResolvedValueOnce(fakeResult);

      await createLegacyTestWorkspace('  spaced-name  ');

      expect(createLegacyTestServer).toHaveBeenCalledWith('admin-1', 'spaced-name');
    });

    it('revalidates /admin/migrations and /admin/servers on success', async () => {
      mockAdminSession();
      vi.mocked(createLegacyTestServer).mockResolvedValueOnce(fakeResult);

      await createLegacyTestWorkspace('test');

      expect(revalidatePath).toHaveBeenCalledWith('/admin/migrations');
      expect(revalidatePath).toHaveBeenCalledWith('/admin/servers');
    });

    it('rejects unauthenticated callers without provisioning', async () => {
      mockUnauthenticated();

      await expect(createLegacyTestWorkspace('test')).rejects.toThrow('Not authenticated');
      expect(createLegacyTestServer).not.toHaveBeenCalled();
    });

    it('rejects non-admin sessions without provisioning', async () => {
      mockNonAdminSession();

      await expect(createLegacyTestWorkspace('test')).rejects.toThrow('Not authorized');
      expect(createLegacyTestServer).not.toHaveBeenCalled();
    });

    it('rejects sessions missing user id', async () => {
      mockAdminSessionWithoutId();

      await expect(createLegacyTestWorkspace('test')).rejects.toThrow(/user id/);
      expect(createLegacyTestServer).not.toHaveBeenCalled();
    });

    it('rejects empty / whitespace-only names', async () => {
      mockAdminSession();

      await expect(createLegacyTestWorkspace('')).rejects.toThrow(/name is required/);
      await expect(createLegacyTestWorkspace('   ')).rejects.toThrow(/name is required/);
      expect(createLegacyTestServer).not.toHaveBeenCalled();
    });

    it('rejects names longer than 100 chars', async () => {
      mockAdminSession();

      await expect(createLegacyTestWorkspace('x'.repeat(101))).rejects.toThrow(/too long/);
      expect(createLegacyTestServer).not.toHaveBeenCalled();
    });

    it('propagates provisioning errors without revalidating', async () => {
      mockAdminSession();
      vi.mocked(createLegacyTestServer).mockRejectedValueOnce(
        new Error('Fly machine creation failed'),
      );

      await expect(createLegacyTestWorkspace('test')).rejects.toThrow(/Fly machine/);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });
});
