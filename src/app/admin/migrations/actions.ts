'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { migrateWorkspaceToOwnApp } from '@/api/services/ServerService';
import type { MigrationResult } from '@/api/services/ServerService';

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
 * Trigger the per-tenant Fly app migration for a single workspace.
 *
 * Synchronous — runs the full snapshot + restore + cutover (~2-3 min).
 * The action holds the HTTP connection open for the duration; if the
 * platform's request timeout cuts in earlier the migration continues
 * server-side (the runner is process-bound, not request-bound) and the
 * row's `status` field reflects the eventual outcome on the next page
 * load. See `docs/per-app-isolation-migration.md` for the runner's
 * recovery semantics on partial failure.
 *
 * Returns the structured `MigrationResult` from the runner so the UI
 * can display the new app/machine IDs and elapsed duration.
 */
export async function migrateOne(serverId: string): Promise<MigrationResult> {
  await verifyAdmin();

  if (!serverId || typeof serverId !== 'string') {
    throw new Error('serverId is required');
  }

  const result = await migrateWorkspaceToOwnApp(serverId);

  revalidatePath('/admin/migrations');
  revalidatePath('/admin/servers');
  return result;
}
