import { db, usageEvents, users, servers } from '@/db';
import { and, eq, gte, lte, inArray, ne, sql, desc } from 'drizzle-orm';

export interface UsageFilter {
  start: Date;
  end: Date;
  userIds?: string[];
  serverIds?: string[];
  excludePreCutover?: boolean;
  // Restrict to events whose server is currently owned by this user. This is
  // how the per-user billing report enforces the invariant "you only ever see
  // servers you own". Under owner-pays (live 2026-05-27) usageEvents.userId is
  // already the server owner, so for post-cutover data this is a no-op; its
  // purpose is to drop legacy *pre*-cutover events that were actor-billed onto
  // a server the actor does not own (and events with no resolvable server).
  ownedBy?: string;
}

export interface SummaryStats {
  totalCostCents: number;
  requestCount: number;
  distinctUsers: number;
  distinctServers: number;
}

export interface DailyPoint {
  bucket: string;
  totalCostCents: number;
  requestCount: number;
}

export interface UserRow {
  userId: string;
  userEmail: string | null;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostCents: number;
}

export interface ServerRow {
  serverId: string | null;
  // Human-readable workspace name from servers.name (null if the serverId has
  // no matching row in `servers`, which can happen for legacy events that
  // stored a Fly machine ID instead of a ws_ ID).
  serverName: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface TaskRow {
  taskId: string | null;
  taskLabel: string | null;
  // Representative serverId + channelId for this task, used by the admin UI
  // to build a deep link into the workspace. MAX() over the events grouped by
  // taskId — tasks typically live on one server/channel, so MAX is equivalent
  // to "any row's value".
  serverId: string | null;
  // Workspace name for the task's server (null if serverId is null or not in `servers`).
  serverName: string | null;
  channelId: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface AgentRow {
  agentId: string | null;
  agentLabel: string | null;
  // Representative serverId for deep-linking into the workspace's agent page.
  serverId: string | null;
  serverName: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface JobRow {
  jobId: string | null;
  // Representative serverId for the deep-link. A job belongs to exactly one
  // server, so MAX() is the same as "any row's value".
  serverId: string | null;
  serverName: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface DayRow {
  // Calendar day, 'YYYY-MM-DD' (truncated in the DB's timezone).
  day: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCostCents: number;
}

function buildWhere(f: UsageFilter) {
  const parts: ReturnType<typeof gte>[] = [
    gte(usageEvents.ts, f.start),
    lte(usageEvents.ts, f.end),
  ];
  if (f.excludePreCutover) parts.push(ne(usageEvents.model, 'pre-cutover-rollup'));
  if (f.userIds && f.userIds.length > 0) parts.push(inArray(usageEvents.userId, f.userIds));
  if (f.serverIds && f.serverIds.length > 0) parts.push(inArray(usageEvents.serverId, f.serverIds));
  if (f.ownedBy) {
    // server_id IN (SELECT id FROM servers WHERE owner_id = :ownedBy).
    // A NULL/unresolvable server_id is not IN the set, so legacy events that
    // never captured a server are excluded too — correct, since they cannot be
    // attributed to a server the viewer owns.
    parts.push(
      inArray(
        usageEvents.serverId,
        db.select({ id: servers.id }).from(servers).where(eq(servers.ownerId, f.ownedBy)),
      ),
    );
  }
  return and(...parts);
}

export async function getSummary(f: UsageFilter): Promise<SummaryStats> {
  const [row] = await db
    .select({
      totalCostCents:  sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:    sql<number>`COUNT(*)::int`,
      distinctUsers:   sql<number>`COUNT(DISTINCT ${usageEvents.userId})::int`,
      distinctServers: sql<number>`COUNT(DISTINCT ${usageEvents.serverId})::int`,
    })
    .from(usageEvents)
    .where(buildWhere(f));
  return row;
}

export async function getDailyTotals(
  f: UsageFilter,
  bucket: 'day' | 'week' | 'month',
): Promise<DailyPoint[]> {
  // date_trunc requires its granularity argument to be a literal, not a bind
  // parameter. Whitelist to the three valid values so sql.raw() is safe.
  //
  // We zero-fill every bucket in [start, end] via generate_series, LEFT JOIN
  // usage_events on bucketed timestamp, so the chart spans the full selected
  // range (days with no activity show as $0 instead of being silently omitted,
  // which would collapse the x-axis to just the populated days).
  const trunc    = bucket === 'day' ? 'day'        : bucket === 'week' ? 'week'       : 'month';
  const fmt      = bucket === 'day' ? 'YYYY-MM-DD' : bucket === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';
  const interval = bucket === 'day' ? '1 day'      : bucket === 'week' ? '1 week'     : '1 month';

  const where = buildWhere(f);

  type RawRow = { bucket: string; total_cost_cents: string; request_count: string };

  const result = await db.execute<RawRow>(sql`
    WITH bucket_series AS (
      SELECT generate_series(
        date_trunc(${sql.raw(`'${trunc}'`)}, ${f.start}::timestamp),
        date_trunc(${sql.raw(`'${trunc}'`)}, ${f.end}::timestamp),
        ${sql.raw(`'${interval}'`)}::interval
      ) AS bucket_ts
    )
    SELECT
      to_char(bs.bucket_ts, ${fmt})                                  AS bucket,
      COALESCE(SUM(${usageEvents.costCents}), 0)::double precision   AS total_cost_cents,
      COUNT(${usageEvents.ts})::int                                  AS request_count
    FROM bucket_series bs
    LEFT JOIN ${usageEvents}
      ON date_trunc(${sql.raw(`'${trunc}'`)}, ${usageEvents.ts}) = bs.bucket_ts
     AND ${where}
    GROUP BY bs.bucket_ts
    ORDER BY bs.bucket_ts
  `);

  return result.rows.map((r) => ({
    bucket:         r.bucket,
    totalCostCents: Number(r.total_cost_cents),
    requestCount:   Number(r.request_count),
  }));
}

export async function getBreakdownByUser(f: UsageFilter): Promise<UserRow[]> {
  return db
    .select({
      userId:              usageEvents.userId,
      userEmail:           users.email,
      requestCount:        sql<number>`COUNT(*)::int`,
      inputTokens:         sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
      outputTokens:        sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      cacheReadTokens:     sql<number>`COALESCE(SUM(${usageEvents.cacheReadTokens}), 0)::int`,
      cacheCreationTokens: sql<number>`COALESCE(SUM(${usageEvents.cacheCreationTokens}), 0)::int`,
      totalCostCents:      sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(usageEvents.userId, users.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.userId, users.email)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByServer(f: UsageFilter): Promise<ServerRow[]> {
  return db
    .select({
      serverId:       usageEvents.serverId,
      serverName:     sql<string | null>`MAX(${servers.name})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(servers, eq(usageEvents.serverId, servers.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.serverId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByTask(f: UsageFilter): Promise<TaskRow[]> {
  return db
    .select({
      taskId:         usageEvents.taskId,
      taskLabel:      sql<string | null>`MAX(${usageEvents.taskLabel})`,
      serverId:       sql<string | null>`MAX(${usageEvents.serverId})`,
      serverName:     sql<string | null>`MAX(${servers.name})`,
      channelId:      sql<string | null>`MAX(${usageEvents.channelId})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(servers, eq(usageEvents.serverId, servers.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.taskId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByAgent(f: UsageFilter): Promise<AgentRow[]> {
  return db
    .select({
      agentId:        usageEvents.agentId,
      agentLabel:     sql<string | null>`MAX(${usageEvents.agentLabel})`,
      serverId:       sql<string | null>`MAX(${usageEvents.serverId})`,
      serverName:     sql<string | null>`MAX(${servers.name})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(servers, eq(usageEvents.serverId, servers.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.agentId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

export async function getBreakdownByJob(f: UsageFilter): Promise<JobRow[]> {
  return db
    .select({
      jobId:          usageEvents.jobId,
      serverId:       sql<string | null>`MAX(${usageEvents.serverId})`,
      serverName:     sql<string | null>`MAX(${servers.name})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .leftJoin(servers, eq(usageEvents.serverId, servers.id))
    .where(buildWhere(f))
    .groupBy(usageEvents.jobId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
}

/**
 * Per-calendar-day usage, including token counts. Unlike getDailyTotals (which
 * zero-fills every bucket in the range to drive a continuous chart), this only
 * returns days that actually had activity and adds input/output token sums —
 * the right shape for a tabular per-day usage list. Ordered newest-first.
 */
export async function getBreakdownByDay(f: UsageFilter): Promise<DayRow[]> {
  return db
    .select({
      day:            sql<string>`to_char(date_trunc('day', ${usageEvents.ts}), 'YYYY-MM-DD')`,
      requestCount:   sql<number>`COUNT(*)::int`,
      inputTokens:    sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
      outputTokens:   sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(sql`date_trunc('day', ${usageEvents.ts})`)
    .orderBy(desc(sql`date_trunc('day', ${usageEvents.ts})`));
}

export interface UsageEventCsvRow {
  ts: Date;
  userId: string;
  serverId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costCents: number;
  taskId: string | null;
  taskLabel: string | null;
  jobId: string | null;
  channelId: string | null;
  channelLabel: string | null;
  agentId: string | null;
  agentLabel: string | null;
  conversationId: string | null;
  anthropicRequestId: string | null;
}

/**
 * Stream raw event rows for CSV export. Paginates 1000 rows at a time.
 * At current scale (one month = 10-100k rows) this is trivial.
 */
export async function* streamEventsForCsv(f: UsageFilter): AsyncIterable<UsageEventCsvRow> {
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const rows = await db
      .select({
        ts: usageEvents.ts,
        userId: usageEvents.userId,
        serverId: usageEvents.serverId,
        model: usageEvents.model,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        cacheReadTokens: usageEvents.cacheReadTokens,
        cacheCreationTokens: usageEvents.cacheCreationTokens,
        costCents: sql<number>`${usageEvents.costCents}::double precision`,
        taskId: usageEvents.taskId,
        taskLabel: usageEvents.taskLabel,
        jobId: usageEvents.jobId,
        channelId: usageEvents.channelId,
        channelLabel: usageEvents.channelLabel,
        agentId: usageEvents.agentId,
        agentLabel: usageEvents.agentLabel,
        conversationId: usageEvents.conversationId,
        anthropicRequestId: usageEvents.anthropicRequestId,
      })
      .from(usageEvents)
      .where(buildWhere(f))
      .orderBy(desc(usageEvents.ts))
      .limit(PAGE)
      .offset(offset);
    if (rows.length === 0) return;
    for (const r of rows) yield r;
    if (rows.length < PAGE) return;
    offset += PAGE;
  }
}
