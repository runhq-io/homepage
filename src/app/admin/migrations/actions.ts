'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { migrateWorkspaceToOwnApp, createLegacyTestServer } from '@/api/services/ServerService';
import type { MigrationResult } from '@/api/services/ServerService';

async function verifyAdmin(): Promise<{ userId: string; email: string }> {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.email) {
    throw new Error('Not authenticated');
  }

  if (!user?.isAdmin) {
    throw new Error('Not authorized');
  }

  if (!user?.id) {
    throw new Error('Session has no user id — re-login required');
  }

  return { userId: user.id, email: user.email };
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

/**
 * Spin up a legacy-shape workspace (provisioned in the shared Fly app
 * with fly_app_name NULL on the row) so an operator can verify the
 * migration flow end-to-end without redeploying master. Owned by the
 * calling admin so it shows up in their normal workspace list and can
 * be opened/used like any other workspace.
 *
 * Synchronous — awaits machine creation + healthy. Returns the new
 * serverId so the UI can deep-link to the workspace if desired.
 */
export async function createLegacyTestWorkspace(name: string): Promise<{
  serverId: string;
  machineId: string;
  serverUrl: string;
}> {
  const { userId } = await verifyAdmin();

  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    throw new Error('Workspace name is required');
  }
  if (trimmed.length > 100) {
    throw new Error('Workspace name too long (max 100 chars)');
  }

  const result = await createLegacyTestServer(userId, trimmed);

  revalidatePath('/admin/migrations');
  revalidatePath('/admin/servers');
  return result;
}
