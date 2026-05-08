'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { deleteApp as flyDeleteApp } from '@/api/services/FlyService';
import {
  adminDeleteServer,
  deleteServersAndDependents,
} from '@/api/services/ServerService';

async function verifyAdmin(): Promise<void> {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.email) {
    throw new Error('Not authenticated');
  }

  if (!user?.isAdmin) {
    throw new Error('Not authorized');
  }
}

/**
 * DB-only delete. Used exclusively for stale rows (DB references a Fly app
 * that no longer exists), so there is nothing on the cloud side to clean up.
 *
 * For any row backed by a real Fly app, callers must use `destroyInfra` so
 * the Fly app + machines + volumes are torn down too.
 */
export async function deleteServers(ids: string[]): Promise<{ success: boolean; count: number }> {
  await verifyAdmin();

  if (ids.length === 0) {
    return { success: true, count: 0 };
  }

  await deleteServersAndDependents(ids);

  revalidatePath('/admin/servers');
  return { success: true, count: ids.length };
}

export type InfraTarget = {
  /** Per-tenant Fly app name (always required — the unit of destruction) */
  flyAppName: string;
  /** DB server id, if a row exists for this app (matched). Omit for orphans. */
  dbServerId?: string;
};

/**
 * Destroy infrastructure for one or more rows shown on the admin/servers page.
 *
 * Behavior per target:
 * - With `dbServerId` (matched): delegates to `adminDeleteServer`, which runs
 *   the full teardown — snapshot volume → delete machine → delete volume →
 *   delete the per-tenant Fly app → delete CF tunnel + port mappings → delete
 *   DB row(s) atomically.
 * - Without `dbServerId` (orphaned Fly app, no DB row): deletes the Fly app
 *   directly via `FlyService.deleteApp`, which cascades to machines + volumes
 *   + networks server-side. Idempotent on 404.
 *
 * Errors are collected per-target so a single failure doesn't abort the rest
 * of the batch — the UI surfaces them in the result alert.
 */
export async function destroyInfra(
  targets: InfraTarget[],
): Promise<{ success: boolean; destroyed: number; errors: string[] }> {
  await verifyAdmin();

  if (targets.length === 0) {
    return { success: true, destroyed: 0, errors: [] };
  }

  let destroyed = 0;
  const errors: string[] = [];

  for (const target of targets) {
    try {
      if (target.dbServerId) {
        const result = await adminDeleteServer(target.dbServerId);
        if (!result.success) {
          errors.push(`${target.flyAppName}: ${result.error ?? 'Unknown error'}`);
          continue;
        }
      } else {
        await flyDeleteApp(target.flyAppName);
      }
      destroyed++;
    } catch (error) {
      errors.push(
        `${target.flyAppName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  revalidatePath('/admin/servers');
  return { success: errors.length === 0, destroyed, errors };
}
