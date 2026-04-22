/**
 * Server Admin Mirror Service
 *
 * Stores a workspace-derived mirror of effective admin status in
 * server_members.is_admin. The workspace is the source of truth — its
 * AdminMirrorPush service POSTs the full admin user-ID list to
 * /api/internal/servers/:serverId/admins/sync on every role mutation and on
 * boot. BE code reads is_admin locally for cloud-op permission checks (restart,
 * destroy, redeploy) so those checks succeed even when the workspace is
 * crashed.
 *
 * BE code never writes to is_admin based on its own logic. Only syncAdmins()
 * touches this column.
 */

import { db } from '../../db/index';
import { serverMembers } from '../../db/schema';
import { and, eq, inArray, not } from 'drizzle-orm';

export interface SyncAdminsResult {
  /** Number of users in the input list who were members and received is_admin=true. */
  accepted: number;
  /** Number of users in the input list who were NOT members of this server. */
  skipped: number;
}

/**
 * Replace the full admin set for a server.
 *
 * - Users in `adminUserIds` who are members of `serverId`: is_admin=true
 * - All other members of `serverId`: is_admin=false
 * - Users in `adminUserIds` who are not members: skipped (logged, not inserted)
 *
 * Single atomic transaction. Idempotent. Safe to call repeatedly.
 */
export async function syncAdmins(
  serverId: string,
  adminUserIds: string[],
): Promise<SyncAdminsResult> {
  // Deduplicate input just in case the workspace sent dupes.
  const uniqueIds = Array.from(new Set(adminUserIds));

  return db.transaction(async (tx) => {
    // Load current membership for this server.
    const existing = await tx
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, serverId));
    const memberSet = new Set(existing.map((r) => r.userId));

    const toAdmin = uniqueIds.filter((u) => memberSet.has(u));
    const skipped = uniqueIds.length - toAdmin.length;

    if (skipped > 0) {
      const ghosts = uniqueIds.filter((u) => !memberSet.has(u));
      console.warn(
        `[ServerAdminMirrorService] sync for ${serverId} skipped ${skipped} non-member user(s): ${ghosts.join(', ')}`,
      );
    }

    // Promote members in the admin list.
    if (toAdmin.length > 0) {
      await tx
        .update(serverMembers)
        .set({ isAdmin: true })
        .where(and(
          eq(serverMembers.serverId, serverId),
          inArray(serverMembers.userId, toAdmin),
        ));
    }

    // Demote all other members of this server.
    const demoteClause = toAdmin.length > 0
      ? and(
          eq(serverMembers.serverId, serverId),
          not(inArray(serverMembers.userId, toAdmin)),
        )
      : eq(serverMembers.serverId, serverId);

    await tx
      .update(serverMembers)
      .set({ isAdmin: false })
      .where(demoteClause);

    return { accepted: toAdmin.length, skipped };
  });
}
