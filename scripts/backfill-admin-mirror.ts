/**
 * One-time backfill: populate server_members.is_admin from each workspace's
 * current effective admin user set.
 *
 * Called once after BE + workspace deploys ship. Workspaces that are offline
 * during backfill are skipped — they'll populate the mirror on their next
 * boot via the register-time reconciliation push. Owners are unaffected
 * either way (the owner check always bypasses the admin mirror).
 *
 * Safe to re-run: each per-server sync is idempotent.
 *
 * Usage:
 *   cd be && pnpm tsx scripts/backfill-admin-mirror.ts
 */

import 'dotenv/config';
import { db } from '../src/db/index';
import { servers } from '../src/db/schema';
import { fetchFromServer } from '../src/api/services/ServerService';
import { syncAdmins } from '../src/api/services/ServerAdminMirrorService';

interface Stats {
  total: number;
  synced: number;
  noServerUrl: number;
  noOwner: number;
  unreachable: number;
  badResponse: number;
}

async function main() {
  const all = await db.select().from(servers);
  const stats: Stats = {
    total: all.length,
    synced: 0,
    noServerUrl: 0,
    noOwner: 0,
    unreachable: 0,
    badResponse: 0,
  };

  console.log(`[backfill] Processing ${all.length} servers...`);

  for (const server of all) {
    if (!server.serverUrl) {
      stats.noServerUrl++;
      continue;
    }
    if (!server.ownerId) {
      stats.noOwner++;
      console.warn(`[backfill] server ${server.id} has no ownerId — skipping`);
      continue;
    }

    try {
      const data = await fetchFromServer<{ success: boolean; admins?: string[] }>(
        server,
        server.ownerId,
        '/admin-list',
        { timeoutMs: 10_000 },
      );
      if (!data.success || !Array.isArray(data.admins)) {
        stats.badResponse++;
        console.warn(`[backfill] server ${server.id}: bad response shape`);
        continue;
      }
      const result = await syncAdmins(server.id, data.admins);
      stats.synced++;
      console.log(
        `[backfill] ${server.id}: synced ${result.accepted} admin(s)` +
          (result.skipped > 0 ? ` (${result.skipped} non-members skipped)` : ''),
      );
    } catch (err) {
      stats.unreachable++;
      console.log(`[backfill] ${server.id}: unreachable (${(err as Error).message})`);
    }
  }

  console.log('\n[backfill] done:');
  console.log(`  total           ${stats.total}`);
  console.log(`  synced          ${stats.synced}`);
  console.log(`  no server_url   ${stats.noServerUrl}`);
  console.log(`  no owner_id     ${stats.noOwner}`);
  console.log(`  unreachable     ${stats.unreachable}`);
  console.log(`  bad response    ${stats.badResponse}`);
  console.log('\nUnreachable workspaces will sync on their next successful boot.');
}

main()
  .catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
