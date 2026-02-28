import { db, servers, users } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { listFlyMachines, isFlyConfigured } from '@/lib/fly-api';
import { listHetznerServers, isHetznerConfigured } from '@/lib/hetzner-api';
import { ServersTable } from './ServersTable';
import type { FlyMachine } from '@/lib/fly-api';
import type { HetznerServer } from '@/lib/hetzner-api';

export const dynamic = 'force-dynamic';

export type InfrastructureRow = {
  /** Unique key for React (provider:machineId or db:serverId) */
  key: string;
  provider: 'fly' | 'hetzner';
  machineId: string;
  machineName: string;
  machineState: string;
  region: string;
  createdAt: string;
  cpuInfo?: string;
  /** If matched to a DB server */
  dbServerId?: string;
  dbServerName?: string;
  ownerName?: string;
  ownerEmail?: string;
  /** 'orphaned' = provider machine with no DB record, 'matched' = has DB record, 'stale' = DB record with no provider machine */
  status: 'orphaned' | 'matched' | 'stale';
};

type DbServer = {
  id: string;
  name: string;
  flyMachineId: string | null;
  machineId: string | null;
  provider: string | null;
  deploymentType: string | null;
  region: string | null;
  createdAt: Date;
  ownerEmail: string | null;
  ownerName: string | null;
};

async function getDbServers(): Promise<DbServer[]> {
  return db
    .select({
      id: servers.id,
      name: servers.name,
      flyMachineId: servers.flyMachineId,
      machineId: servers.machineId,
      provider: servers.provider,
      deploymentType: servers.deploymentType,
      region: servers.flyRegion,
      createdAt: servers.createdAt,
      ownerEmail: users.email,
      ownerName: users.name,
    })
    .from(servers)
    .leftJoin(users, eq(servers.ownerId, users.id))
    .orderBy(desc(servers.createdAt));
}

function buildRows(
  flyMachines: FlyMachine[],
  hetznerServers: HetznerServer[],
  dbServers: DbServer[]
): InfrastructureRow[] {
  const rows: InfrastructureRow[] = [];
  const matchedDbIds = new Set<string>();

  // Process Fly machines
  for (const machine of flyMachines) {
    const dbMatch = dbServers.find(
      s => s.flyMachineId === machine.id || s.machineId === machine.id
    );

    if (dbMatch) matchedDbIds.add(dbMatch.id);

    const guest = machine.config?.guest;
    const cpuInfo = guest
      ? `${guest.cpus || '?'}c / ${guest.memory_mb || '?'}MB`
      : undefined;

    rows.push({
      key: `fly:${machine.id}`,
      provider: 'fly',
      machineId: machine.id,
      machineName: machine.name,
      machineState: machine.state,
      region: machine.region,
      createdAt: machine.created_at,
      cpuInfo,
      dbServerId: dbMatch?.id,
      dbServerName: dbMatch?.name,
      ownerName: dbMatch?.ownerName ?? undefined,
      ownerEmail: dbMatch?.ownerEmail ?? undefined,
      status: dbMatch ? 'matched' : 'orphaned',
    });
  }

  // Process Hetzner servers
  for (const server of hetznerServers) {
    const hetznerIdStr = String(server.id);
    const dbMatch = dbServers.find(s => s.machineId === hetznerIdStr);

    if (dbMatch) matchedDbIds.add(dbMatch.id);

    const cpuInfo = server.server_type
      ? `${server.server_type.cores}c / ${server.server_type.memory}GB`
      : undefined;

    rows.push({
      key: `hetzner:${server.id}`,
      provider: 'hetzner',
      machineId: hetznerIdStr,
      machineName: server.name,
      machineState: server.status,
      region: server.datacenter?.location?.name ?? server.datacenter?.name ?? '',
      createdAt: server.created,
      cpuInfo,
      dbServerId: dbMatch?.id,
      dbServerName: dbMatch?.name,
      ownerName: dbMatch?.ownerName ?? undefined,
      ownerEmail: dbMatch?.ownerEmail ?? undefined,
      status: dbMatch ? 'matched' : 'orphaned',
    });
  }

  // Find stale DB records: remote servers with a machineId that don't match any provider machine
  for (const dbServer of dbServers) {
    if (matchedDbIds.has(dbServer.id)) continue;
    if (dbServer.deploymentType !== 'remote') continue;
    // Only flag as stale if the server has a machine reference
    if (!dbServer.flyMachineId && !dbServer.machineId) continue;

    rows.push({
      key: `stale:${dbServer.id}`,
      provider: (dbServer.provider as 'fly' | 'hetzner') || 'fly',
      machineId: dbServer.machineId || dbServer.flyMachineId || '',
      machineName: dbServer.name,
      machineState: 'unknown',
      region: dbServer.region || '',
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

  // Fetch all data in parallel
  const [flyResult, hetznerResult, dbServers] = await Promise.all([
    isFlyConfigured()
      ? listFlyMachines().catch(err => {
          apiErrors.push(`Fly.io: ${err instanceof Error ? err.message : 'Unknown error'}`);
          return [] as FlyMachine[];
        })
      : (apiErrors.push('Fly.io: FLY_API_TOKEN not configured'), Promise.resolve([] as FlyMachine[])),
    isHetznerConfigured()
      ? listHetznerServers().catch(err => {
          apiErrors.push(`Hetzner: ${err instanceof Error ? err.message : 'Unknown error'}`);
          return [] as HetznerServer[];
        })
      : (apiErrors.push('Hetzner: HETZNER_API_TOKEN not configured'), Promise.resolve([] as HetznerServer[])),
    getDbServers(),
  ]);

  const rows = buildRows(flyResult, hetznerResult, dbServers);

  // Compute stats
  const stats = {
    total: rows.length,
    fly: rows.filter(r => r.provider === 'fly').length,
    hetzner: rows.filter(r => r.provider === 'hetzner').length,
    orphaned: rows.filter(r => r.status === 'orphaned').length,
    matched: rows.filter(r => r.status === 'matched').length,
    stale: rows.filter(r => r.status === 'stale').length,
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Infrastructure</h1>

      {/* API Error Banners */}
      {apiErrors.length > 0 && (
        <div className="mb-6 space-y-2">
          {apiErrors.map((err, i) => (
            <div key={i} className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-3 text-sm text-yellow-300">
              {err}
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <StatCard label="Total Machines" value={stats.total} />
        <StatCard label="Fly.io" value={stats.fly} color="purple" />
        <StatCard label="Hetzner" value={stats.hetzner} color="blue" />
        <StatCard label="Matched" value={stats.matched} color="green" />
        <StatCard label="Orphaned" value={stats.orphaned} color="red" />
        <StatCard label="Stale" value={stats.stale} color="yellow" />
      </div>

      {/* Table */}
      <ServersTable rows={rows} />
    </div>
  );
}

function StatCard({
  label,
  value,
  color = 'slate'
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
