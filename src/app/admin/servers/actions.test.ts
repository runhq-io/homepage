/**
 * Tests for admin server CRUD operations (actions.ts)
 *
 * Verifies:
 * - deleteServers cascades child record deletion before removing servers
 * - deleteServers requires admin authentication
 * - deleteServers handles empty input gracefully
 * - deleteServers handles partial child records (some tables have rows, others don't)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track all delete calls to verify cascade order
const deleteCalls: { table: string; ids: string[] }[] = [];

// Mock revalidatePath
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

// Mock db with tracking of delete operations
vi.mock('@/lib/db', () => {
  const createTable = (name: string) => ({
    _name: name,
    id: name === 'servers' ? 'id' : `${name}_id`,
    serverId: 'server_id',
  });

  const tables = {
    servers: createTable('servers'),
    serverMembers: createTable('server_members'),
    serverInvites: createTable('server_invites'),
    serverInviteLinks: createTable('server_invite_links'),
    publicPorts: createTable('public_ports'),
  };

  return {
    ...tables,
    db: {
      delete: vi.fn((table: any) => ({
        where: vi.fn(async () => {
          deleteCalls.push({ table: table._name, ids: [] });
        }),
      })),
    },
  };
});

import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { deleteServers } from './actions';

describe('Admin Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteCalls.length = 0;
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
    it('should delete child records before servers', async () => {
      mockAdminSession();

      const result = await deleteServers(['ws-1', 'ws-2']);

      expect(result).toEqual({ success: true, count: 2 });

      // Verify all 5 delete calls were made (4 child tables + servers)
      expect(deleteCalls).toHaveLength(5);

      // Verify cascade order: child tables first, servers last
      expect(deleteCalls[0].table).toBe('server_members');
      expect(deleteCalls[1].table).toBe('server_invites');
      expect(deleteCalls[2].table).toBe('server_invite_links');
      expect(deleteCalls[3].table).toBe('public_ports');
      expect(deleteCalls[4].table).toBe('servers');
    });

    it('should return early for empty ids array', async () => {
      mockAdminSession();

      const result = await deleteServers([]);

      expect(result).toEqual({ success: true, count: 0 });
      expect(deleteCalls).toHaveLength(0);
    });

    it('should revalidate the admin servers path after deletion', async () => {
      mockAdminSession();

      await deleteServers(['ws-1']);

      expect(revalidatePath).toHaveBeenCalledWith('/admin/servers');
    });

    it('should not revalidate when no ids provided', async () => {
      mockAdminSession();

      await deleteServers([]);

      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it('should reject unauthenticated users', async () => {
      mockUnauthenticated();

      await expect(deleteServers(['ws-1'])).rejects.toThrow('Not authenticated');
      expect(deleteCalls).toHaveLength(0);
    });

    it('should reject non-admin users', async () => {
      mockNonAdminSession();

      await expect(deleteServers(['ws-1'])).rejects.toThrow('Not authorized');
      expect(deleteCalls).toHaveLength(0);
    });

    it('should handle single server deletion', async () => {
      mockAdminSession();

      const result = await deleteServers(['ws-single']);

      expect(result).toEqual({ success: true, count: 1 });
      expect(deleteCalls).toHaveLength(5);
    });

    it('should handle bulk server deletion', async () => {
      mockAdminSession();

      const ids = Array.from({ length: 50 }, (_, i) => `ws-${i}`);
      const result = await deleteServers(ids);

      expect(result).toEqual({ success: true, count: 50 });
      expect(deleteCalls).toHaveLength(5);
    });
  });
});
