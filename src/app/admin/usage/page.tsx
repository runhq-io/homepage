import {
  getSummary,
  getDailyTotals,
  getBreakdownByUser,
  getBreakdownByServer,
  getBreakdownByTask,
  getBreakdownByAgent,
  getBreakdownByJob,
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

  // Validate date inputs — malformed strings should fall back to defaults, not propagate NaN to Postgres.
  const parseDate = (s: string | undefined, fallback: Date): Date => {
    if (!s) return fallback;
    const d = new Date(s);
    return isNaN(d.getTime()) ? fallback : d;
  };

  const start = parseDate(sp.start, defaultStart);
  const end = parseDate(sp.end, now);
  const groupBy = (['day', 'week', 'month'] as const).find((v) => v === sp.groupBy) ?? 'day';
  const userIds = sp.userIds?.split(',').filter(Boolean);
  const serverIds = sp.serverIds?.split(',').filter(Boolean);

  // excludePreCutover is always true for chart/breakdowns — pre-cutover rollup events
  // can't be meaningfully placed on a daily/weekly/monthly axis (their ts is synthetic).
  // The banner separately surfaces the rolled-up total.
  return {
    start,
    end,
    userIds,
    serverIds,
    groupBy,
    excludePreCutover: true,
  };
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseFilter(sp);

  const [summary, daily, byUser, byServer, byTask, byAgent, byJob] = await Promise.all([
    getSummary({ ...f, excludePreCutover: false }),
    getDailyTotals({ ...f }, f.groupBy),
    getBreakdownByUser({ ...f, excludePreCutover: true }),
    getBreakdownByServer({ ...f, excludePreCutover: true }),
    getBreakdownByTask({ ...f, excludePreCutover: true }),
    getBreakdownByAgent({ ...f, excludePreCutover: true }),
    getBreakdownByJob({ ...f, excludePreCutover: true }),
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

  // Base URL of the client app (app.runhq.io in prod). Used to deep-link into
  // workspaces from the admin breakdowns. Matches the pattern used by
  // FlyService.ts when constructing cross-app URLs.
  const appBase = process.env.CLIENT_URL ?? 'https://app.runhq.io';

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Usage</h1>
        <a
          href={csvHref}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
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

      {preCutoverTotal > 0 && (
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
          // Internal admin page — always linkable.
          href: `/admin/users/${r.userId}`,
        }))}
      />

      <BreakdownTable
        title="By server"
        rows={byServer.map((r) => ({
          key: r.serverId ?? '__null',
          // Prefer human name; fall back to the raw ws_ id, then "— Unknown —" for null.
          label: r.serverName ?? r.serverId ?? '— Unknown —',
          // Show the id as the secondary line when we have a name (so admins
          // can still eyeball / copy the ws_... value).
          extra: r.serverName && r.serverId ? r.serverId : undefined,
          cost: r.totalCostCents,
          requests: r.requestCount,
          href: r.serverId ? `${appBase}/server/${r.serverId}` : undefined,
        }))}
      />

      <BreakdownTable
        title="By task"
        rows={byTask.map((r) => ({
          key: r.taskId ?? '__null',
          label:
            r.taskLabel ??
            (r.taskId ? r.taskId.substring(0, 12) + '…' : '— No task context —'),
          // Workspace name tags the task so admins can distinguish tasks with
          // identical labels across workspaces (e.g. "Fix login" in both envs).
          extra: r.serverName ?? undefined,
          cost: r.totalCostCents,
          requests: r.requestCount,
          href:
            r.taskId && r.serverId && r.channelId
              ? `${appBase}/server/${r.serverId}/channel/${r.channelId}?todo=${r.taskId}`
              : undefined,
        }))}
      />

      <BreakdownTable
        title="By agent"
        rows={byAgent.map((r) => ({
          key: r.agentId ?? '__null',
          label:
            r.agentLabel ??
            (r.agentId ? r.agentId.substring(0, 12) + '…' : '— No agent context —'),
          extra: r.serverName ?? undefined,
          cost: r.totalCostCents,
          requests: r.requestCount,
          href:
            r.agentId && r.serverId
              ? `${appBase}/server/${r.serverId}/agent/${r.agentId}`
              : undefined,
        }))}
      />

      <BreakdownTable
        title="By job"
        rows={byJob.map((r) => ({
          key: r.jobId ?? '__null',
          label: r.jobId ? r.jobId.substring(0, 12) + '…' : '— No job context —',
          extra: r.serverName ?? undefined,
          cost: r.totalCostCents,
          requests: r.requestCount,
          href:
            r.jobId && r.serverId
              ? `${appBase}/server/${r.serverId}/session/${r.jobId}`
              : undefined,
        }))}
      />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800 p-6">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-bold text-white">{value}</div>
    </div>
  );
}
