import {
  getSummary,
  getDailyTotals,
  getBreakdownByUser,
  getBreakdownByServer,
  getBreakdownByTask,
  getBreakdownByAgent,
  type UsageFilter,
} from '@/api/services/UsageReportService';
import { UsageFilters } from './UsageFilters';
import { UsageChart } from './UsageChart';
import { BreakdownTable } from './BreakdownTable';
import { PreCutoverBanner } from './PreCutoverBanner';

export const dynamic = 'force-dynamic';

function parseFilter(
  sp: Record<string, string | undefined>,
): UsageFilter & { groupBy: 'day' | 'week' | 'month' } {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 864e5);

  const start = sp.start ? new Date(sp.start) : defaultStart;
  const end = sp.end ? new Date(sp.end) : now;
  const groupBy = (['day', 'week', 'month'] as const).find((v) => v === sp.groupBy) ?? 'day';
  const userIds = sp.userIds?.split(',').filter(Boolean);
  const serverIds = sp.serverIds?.split(',').filter(Boolean);

  return {
    start,
    end,
    userIds,
    serverIds,
    groupBy,
    excludePreCutover: groupBy === 'day',
  };
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseFilter(sp);

  const [summary, daily, byUser, byServer, byTask, byAgent] = await Promise.all([
    getSummary({ ...f, excludePreCutover: false }),
    getDailyTotals({ ...f }, f.groupBy),
    getBreakdownByUser({ ...f, excludePreCutover: true }),
    getBreakdownByServer({ ...f, excludePreCutover: true }),
    getBreakdownByTask({ ...f, excludePreCutover: true }),
    getBreakdownByAgent({ ...f, excludePreCutover: true }),
  ]);

  const preCutoverTotal =
    summary.totalCostCents - byUser.reduce((s, r) => s + r.totalCostCents, 0);

  const csvHref =
    '/api/admin/usage/csv?' +
    new URLSearchParams({
      start: f.start.toISOString(),
      end: f.end.toISOString(),
      ...(f.userIds?.length ? { userIds: f.userIds.join(',') } : {}),
      ...(f.serverIds?.length ? { serverIds: f.serverIds.join(',') } : {}),
    }).toString();

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Usage</h1>
        <a
          href={csvHref}
          className="rounded bg-black px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
        >
          Export CSV
        </a>
      </header>

      <UsageFilters current={f} />

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard
          label="Total spend"
          value={`$${(summary.totalCostCents / 100).toFixed(2)}`}
        />
        <SummaryCard label="Requests" value={summary.requestCount.toLocaleString()} />
        <SummaryCard label="Users" value={summary.distinctUsers.toString()} />
        <SummaryCard label="Servers" value={summary.distinctServers.toString()} />
      </div>

      {preCutoverTotal > 0 && f.groupBy === 'day' && (
        <PreCutoverBanner totalCents={preCutoverTotal} />
      )}

      <UsageChart data={daily} bucket={f.groupBy} />

      <BreakdownTable
        title="By user"
        rows={byUser.map((r) => ({
          key: r.userId,
          label: r.userEmail ?? r.userId.substring(0, 8),
          cost: r.totalCostCents,
          requests: r.requestCount,
          extra: `${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out`,
        }))}
      />

      <BreakdownTable
        title="By server"
        rows={byServer.map((r) => ({
          key: r.serverId ?? '__null',
          label: r.serverId ?? '— Unknown —',
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />

      <BreakdownTable
        title="By task"
        rows={byTask.map((r) => ({
          key: r.taskId ?? '__null',
          label:
            r.taskLabel ??
            (r.taskId ? r.taskId.substring(0, 12) + '…' : '— No task context —'),
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />

      <BreakdownTable
        title="By agent"
        rows={byAgent.map((r) => ({
          key: r.agentId ?? '__null',
          label:
            r.agentLabel ??
            (r.agentId ? r.agentId.substring(0, 12) + '…' : '— No agent context —'),
          cost: r.totalCostCents,
          requests: r.requestCount,
        }))}
      />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
