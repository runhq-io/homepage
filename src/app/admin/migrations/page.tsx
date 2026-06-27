import { db, servers, users } from '@/db';
import { and, eq, isNull, isNotNull, desc, like } from 'drizzle-orm';
import { MigrationsTable, type WorkspaceRow } from './MigrationsTable';

// Disable caching — operators need a fresh view of `status` to confirm
// migrations have completed and to see post-cutover state.
export const dynamic = 'force-dynamic';

async function getEligibleLegacy(): Promise<WorkspaceRow[]> {
  // Eligible: remote workspaces still in the shared app (fly_app_name IS NULL).
  // The migrator also requires machineId + volumeId to be set; we surface those
  // here so the operator can spot rows that aren't actually migratable yet.
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      machineId: servers.machineId,
      volumeId: servers.volumeId,
      flyAppName: servers.flyAppName,
      flyNetworkName: servers.flyNetworkName,
      region: servers.region,
      status: servers.status,
      tier: servers.tier,
      createdAt: servers.createdAt,
      ownerEmail: users.email,
      ownerName: users.name,
    })
    .from(servers)
    .leftJoin(users, eq(servers.ownerId, users.id))
    .where(
      and(
        eq(servers.deploymentType, 'remote'),
        isNull(servers.flyAppName),
      ),
    )
    .orderBy(desc(servers.createdAt));

  return rows.map(toRow);
}

async function getMigrated(): Promise<WorkspaceRow[]> {
  // Already migrated: per-tenant `ws-*` apps. Excludes the legacy shared app
  // name in case it ever leaks into the column via backfill.
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      machineId: servers.machineId,
      volumeId: servers.volumeId,
      flyAppName: servers.flyAppName,
      flyNetworkName: servers.flyNetworkName,
      region: servers.region,
      status: servers.status,
      tier: servers.tier,
      createdAt: servers.createdAt,
      ownerEmail: users.email,
      ownerName: users.name,
    })
    .from(servers)
    .leftJoin(users, eq(servers.ownerId, users.id))
    .where(
      and(
        eq(servers.deploymentType, 'remote'),
        isNotNull(servers.flyAppName),
        like(servers.flyAppName, 'ws-%'),
      ),
    )
    .orderBy(desc(servers.createdAt));

  return rows.map(toRow);
}

function toRow(row: {
  id: string;
  name: string;
  machineId: string | null;
  volumeId: string | null;
  flyAppName: string | null;
  flyNetworkName: string | null;
  region: string | null;
  status: string | null;
  tier: string | null;
  createdAt: Date;
  ownerEmail: string | null;
  ownerName: string | null;
}): WorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    machineId: row.machineId,
    volumeId: row.volumeId,
    flyAppName: row.flyAppName,
    flyNetworkName: row.flyNetworkName,
    region: row.region,
    status: row.status,
    tier: row.tier,
    createdAt: row.createdAt.toISOString(),
    ownerEmail: row.ownerEmail,
    ownerName: row.ownerName,
  };
}

export default async function MigrationsPage() {
  const [eligible, migrated] = await Promise.all([
    getEligibleLegacy(),
    getMigrated(),
  ]);

  return (
    <div className="max-w-[1400px] space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-white">Per-tenant App Migrations</h1>
        <p className="mt-2 text-sm text-slate-400">
          Move legacy workspaces from the shared <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-xs">fishtank-workspaces</code> /
          {' '}<code className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-xs">runhq-workspaces-staging</code> Fly app into their own per-tenant
          app on a dedicated 6PN network. ~2-3 minutes per workspace; the machine is
          stopped during cutover so any in-flight session is interrupted briefly.
          See <code className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-xs">docs/per-app-isolation-migration.md</code>.
        </p>
      </header>

      <MigrationsTable eligible={eligible} migrated={migrated} />
    </div>
  );
}
