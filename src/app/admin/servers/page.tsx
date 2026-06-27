import { db, servers, users } from '@/db';
import { eq, desc } from 'drizzle-orm';
import {
  listAppsInOrg,
  listMachines,
  isConfigured as isFlyConfigured,
  type FlyMachine,
} from '@/api/services/FlyService';
import { ServersTable } from './ServersTable';

export const dynamic = 'force-dynamic';

/**
 * One row per piece of server infrastructure to manage.
 *
 * Each user "server" lives in its own Fly app under per-app isolation
 * (`workspaceAppName(serverId)` in FlyService.ts). The status field categorizes
 * each row by which side of the (Fly app ↔ DB row) join is missing.
 */
export type InfrastructureRow = {
  /** Stable React key (`fly:<app>` or `stale:<serverId>`) */
  key: string;
  provider: 'fly';
  /** Per-tenant Fly app name (always set; equals `workspaceAppName(serverId)` for matched rows) */
  flyAppName: string;
  /** First machine in the app, if any */
  machineId: string;
  machineName: string;
  machineState: string;
  region: string;
  createdAt: string;
  cpuInfo?: string;
  /** DB-side fields (only when status=matched|stale) */
  dbServerId?: string;
  dbServerName?: string;
  ownerName?: string;
  ownerEmail?: string;
  /**
   * matched  = Fly app exists AND a DB server row references it
   * orphaned = Fly app exists but no DB row references it (cleanup target)
   * stale    = DB row references a Fly app name that no longer exists
   */
  status: 'orphaned' | 'matched' | 'stale';
};

type DbServer = {
  id: string;
  name: string;
  machineId: string | null;
  flyAppName: string | null;
  provider: string | null;
  deploymentType: string | null;
  region: string | null;
  createdAt: Date;
  ownerEmail: string | null;
  ownerName: string | null;
};

const WORKSPACE_APP_PREFIX = 'ws-';

async function getDbServers(): Promise<DbServer[]> {
  return db
    .select({
      id: servers.id,
      name: servers.name,
      machineId: servers.machineId,
      flyAppName: servers.flyAppName,
      provider: servers.provider,
      deploymentType: servers.deploymentType,
      region: servers.region,
      createdAt: servers.createdAt,
      ownerEmail: users.email,
      ownerName: users.name,
    })
    .from(servers)
    .leftJoin(users, eq(servers.ownerId, users.id))
    .orderBy(desc(servers.createdAt));
}

/**
 * Collect (app, machines) pairs for every per-tenant workspace Fly app in the
 * org. Listing machines is per-app (the Machines REST API has no global
 * endpoint), so we fan out one request per app — bounded by the small number
 * of workspaces.
 *
 * `apiErrors` accumulates per-app failures so a single rotten app doesn't
 * blank out the whole admin page.
 */
async function collectFlyAppsAndMachines(
  apiErrors: string[],
): Promise<Array<{ appName: string; appStatus: string; machines: FlyMachine[] }>> {
  let apps: Array<{ name: string; status: string }>;
  try {
    apps = await listAppsInOrg(WORKSPACE_APP_PREFIX);
  } catch (err) {
    apiErrors.push(`Fly.io listAppsInOrg: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return [];
  }

  const results = await Promise.all(
    apps.map(async (app) => {
      try {
        const machines = await listMachines(app.name);
        return { appName: app.name, appStatus: app.status, machines };
      } catch (err) {
        apiErrors.push(
          `Fly.io listMachines(${app.name}): ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
        return { appName: app.name, appStatus: app.status, machines: [] as FlyMachine[] };
      }
    }),
  );
  return results;
}

function buildRows(
  flyApps: Array<{ appName: string; appStatus: string; machines: FlyMachine[] }>,
  dbServers: DbServer[],
): InfrastructureRow[] {
  const rows: InfrastructureRow[] = [];
  const matchedDbIds = new Set<string>();

  for (const { appName, appStatus, machines } of flyApps) {
    const dbMatch = dbServers.find((s) => s.flyAppName === appName);
    if (dbMatch) matchedDbIds.add(dbMatch.id);

    // Workspaces are 1 machine per app under per-app isolation. If somehow
    // multiple exist we surface the first; the destroy path operates at the
    // app level so all machines get cleaned up regardless.
    const machine = machines[0];
    const guest = machine?.config?.guest;
    const cpuInfo = guest ? `${guest.cpus ?? '?'}c / ${guest.memory_mb ?? '?'}MB` : undefined;

    rows.push({
      key: `fly:${appName}`,
      provider: 'fly',
      flyAppName: appName,
      machineId: machine?.id ?? '',
      machineName: machine?.name ?? appName,
      machineState: machine?.state ?? appStatus ?? 'unknown',
      region: machine?.region ?? '',
      createdAt: machine?.created_at ?? new Date(0).toISOString(),
      cpuInfo,
      dbServerId: dbMatch?.id,
      dbServerName: dbMatch?.name,
      ownerName: dbMatch?.ownerName ?? undefined,
      ownerEmail: dbMatch?.ownerEmail ?? undefined,
      status: dbMatch ? 'matched' : 'orphaned',
    });
  }

  // Stale DB rows: remote server points at a Fly app that no longer exists.
  for (const dbServer of dbServers) {
    if (matchedDbIds.has(dbServer.id)) continue;
    if (dbServer.deploymentType !== 'remote') continue;
    if (!dbServer.flyAppName) continue;

    rows.push({
      key: `stale:${dbServer.id}`,
      provider: 'fly',
      flyAppName: dbServer.flyAppName,
      machineId: dbServer.machineId ?? '',
      machineName: dbServer.name,
      machineState: 'unknown',
      region: dbServer.region ?? '',
      createdAt: dbServer.createdAt.toISOString(),
      dbServerId: dbServer.id,
      dbServerName: dbServer.name,
      ownerName: dbServer.ownerName ?? undefined,
      ownerEmail: dbServer.ownerEmail ?? undefined,
      status: 'stale',
    });
  }

  return rows;
}

export default async function ServersAdminPage() {
  const apiErrors: string[] = [];

  const flyDataPromise = isFlyConfigured()
    ? collectFlyAppsAndMachines(apiErrors)
    : (apiErrors.push('Fly.io: FLY_API_TOKEN not configured'),
      Promise.resolve(
        [] as Array<{ appName: string; appStatus: string; machines: FlyMachine[] }>,
      ));

  const [flyApps, dbServers] = await Promise.all([flyDataPromise, getDbServers()]);

  const rows = buildRows(flyApps, dbServers);

  const stats = {
    total: rows.length,
    orphaned: rows.filter((r) => r.status === 'orphaned').length,
    matched: rows.filter((r) => r.status === 'matched').length,
    stale: rows.filter((r) => r.status === 'stale').length,
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Infrastructure</h1>

      {apiErrors.length > 0 && (
        <div className="mb-6 space-y-2">
          {apiErrors.map((err, i) => (
            <div key={i} className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-3 text-sm text-yellow-300">
              {err}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Machines" value={stats.total} />
        <StatCard label="Matched" value={stats.matched} color="green" />
        <StatCard label="Orphaned" value={stats.orphaned} color="red" />
        <StatCard label="Stale" value={stats.stale} color="yellow" />
      </div>

      <ServersTable rows={rows} />
    </div>
  );
}

function StatCard({
  label,
  value,
  color = 'slate',
}: {
  label: string;
  value: number;
  color?: 'slate' | 'blue' | 'purple' | 'green' | 'yellow' | 'red';
}) {
  const colorClasses = {
    slate: 'bg-slate-700 text-slate-300',
    blue: 'bg-blue-900/50 text-blue-400',
    purple: 'bg-purple-900/50 text-purple-400',
    green: 'bg-green-900/50 text-green-400',
    yellow: 'bg-yellow-900/50 text-yellow-400',
    red: 'bg-red-900/50 text-red-400',
  };

  return (
    <div className={`rounded-lg p-4 ${colorClasses[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-sm opacity-80">{label}</p>
    </div>
  );
}
