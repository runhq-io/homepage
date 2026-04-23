import { db, usageEvents, users } from '@/db';
import { and, eq, gte, lte, inArray, ne, sql, desc } from 'drizzle-orm';

export interface UsageFilter {
  start: Date;
  end: Date;
  userIds?: string[];
  serverIds?: string[];
  excludePreCutover?: boolean;
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
  channelId: string | null;
  requestCount: number;
  totalCostCents: number;
}

export interface AgentRow {
  agentId: string | null;
  agentLabel: string | null;
  // Representative serverId for deep-linking into the workspace's agent page.
  serverId: string | null;
  requestCount: number;
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
  // We use db.execute with a raw SQL template to avoid Drizzle re-expanding the
  // bucketing expression in GROUP BY and ORDER BY (which causes Postgres to
  // complain that the column must appear in GROUP BY).
  const trunc = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';
  const fmt   = bucket === 'day' ? 'YYYY-MM-DD' : bucket === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';

  const where = buildWhere(f);

  type RawRow = { bucket: string; total_cost_cents: string; request_count: string };

  const result = await db.execute<RawRow>(sql`
    SELECT
      to_char(date_trunc(${sql.raw(`'${trunc}'`)}, ${usageEvents.ts}), ${fmt}) AS bucket,
      COALESCE(SUM(${usageEvents.costCents}), 0)::double precision              AS total_cost_cents,
      COUNT(*)::int                                                              AS request_count
    FROM ${usageEvents}
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
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
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
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
      channelId:      sql<string | null>`MAX(${usageEvents.channelId})`,
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
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
      requestCount:   sql<number>`COUNT(*)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(buildWhere(f))
    .groupBy(usageEvents.agentId)
    .orderBy(desc(sql`COALESCE(SUM(${usageEvents.costCents}), 0)`));
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
