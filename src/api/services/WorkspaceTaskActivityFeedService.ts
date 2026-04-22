import { and, count, eq, gt, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { workspaceTaskActivity, workspaceTaskComments } from '../../db/schema';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeedFilters {
  userId?: string;
  type?: string;
  excludeAgents?: boolean;
  limit: number;
  offset: number;
}

export interface FeedEntry {
  id: string;
  todoId: string;            // maps from .taskId for workspace-side compatibility
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  attachments: null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
}

export interface FeedResult {
  entries: FeedEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ─── listFeed ─────────────────────────────────────────────────────────────────

/**
 * Returns a server-wide unified activity feed (workspace_task_activity rows
 * merged with workspace_task_comments rows) sorted descending by created_at.
 *
 * `type === 'comment'` is a pseudo-type that surfaces only comment rows.
 * All other type values filter only activity rows.
 *
 * Pagination (limit/offset) is applied after merging and sorting.
 *
 * NOTE: intentional in-memory merge/sort/paginate. At current data volumes
 * (low-thousands of rows per server) this is simpler than a cross-table SQL
 * UNION with correlated pagination. If any server exceeds ~10k combined
 * activity+comments, push ORDER BY created_at DESC + LIMIT into each
 * sub-query and merge a pre-sorted k-way stream (fetch limit+offset from
 * each, merge, slice).
 */
export async function listFeed(serverId: string, filters: FeedFilters): Promise<FeedResult> {
  const activityWhere = [eq(workspaceTaskActivity.serverId, serverId)];
  const commentsWhere = [eq(workspaceTaskComments.serverId, serverId)];

  if (filters.userId) {
    activityWhere.push(eq(workspaceTaskActivity.createdById, filters.userId));
    commentsWhere.push(eq(workspaceTaskComments.createdById, filters.userId));
  }

  if (filters.excludeAgents) {
    activityWhere.push(ne(workspaceTaskActivity.createdByType, 'agent'));
    commentsWhere.push(ne(workspaceTaskComments.createdByType, 'agent'));
  }

  const includeActivity = !filters.type || filters.type !== 'comment';
  const includeComments = !filters.type || filters.type === 'comment';

  if (filters.type && filters.type !== 'comment') {
    activityWhere.push(eq(workspaceTaskActivity.type, filters.type));
  }

  const [activityRows, commentRows] = await Promise.all([
    includeActivity
      ? db
          .select({
            id: workspaceTaskActivity.id,
            taskId: workspaceTaskActivity.taskId,
            type: workspaceTaskActivity.type,
            content: workspaceTaskActivity.content,
            metadata: workspaceTaskActivity.metadata,
            createdById: workspaceTaskActivity.createdById,
            createdByName: workspaceTaskActivity.createdByName,
            createdAt: workspaceTaskActivity.createdAt,
          })
          .from(workspaceTaskActivity)
          .where(and(...activityWhere))
      : Promise.resolve([]),
    includeComments
      ? db
          .select({
            id: workspaceTaskComments.id,
            taskId: workspaceTaskComments.taskId,
            content: workspaceTaskComments.content,
            createdById: workspaceTaskComments.createdById,
            createdByName: workspaceTaskComments.createdByName,
            createdAt: workspaceTaskComments.createdAt,
          })
          .from(workspaceTaskComments)
          .where(and(...commentsWhere))
      : Promise.resolve([]),
  ]);

  const entries: FeedEntry[] = [
    ...activityRows.map((r) => ({
      id: r.id,
      todoId: r.taskId,
      type: r.type,
      content: r.content ?? null,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      attachments: null as null,
      createdBy: r.createdById ?? null,
      createdByName: r.createdByName ?? null,
      createdAt: r.createdAt.getTime(),
    })),
    ...commentRows.map((r) => ({
      id: r.id,
      todoId: r.taskId,
      type: 'comment' as const,
      content: r.content,
      metadata: null as null,
      attachments: null as null,
      createdBy: r.createdById ?? null,
      createdByName: r.createdByName ?? null,
      createdAt: r.createdAt.getTime(),
    })),
  ];

  // Sort merged set DESC by createdAt
  entries.sort((a, b) => b.createdAt - a.createdAt);

  const total = entries.length;
  const paged = entries.slice(filters.offset, filters.offset + filters.limit);

  return { entries: paged, total, limit: filters.limit, offset: filters.offset };
}

// ─── countNew ─────────────────────────────────────────────────────────────────

/**
 * Returns the total number of activity + comment rows for the given server
 * that were created strictly after `sinceMs` (milliseconds since epoch).
 *
 * Used by the sidebar unread-badge to show how many feed items a member
 * hasn't seen yet.  Two separate COUNT queries keep the implementation
 * simple and avoid a UNION; at current row volumes the extra round-trip is
 * negligible.
 */
export async function countNew(serverId: string, sinceMs: number): Promise<number> {
  const since = new Date(sinceMs);

  const [{ value: activityCount }] = await db
    .select({ value: count() })
    .from(workspaceTaskActivity)
    .where(and(
      eq(workspaceTaskActivity.serverId, serverId),
      gt(workspaceTaskActivity.createdAt, since),
    ));

  const [{ value: commentCount }] = await db
    .select({ value: count() })
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.serverId, serverId),
      gt(workspaceTaskComments.createdAt, since),
    ));

  return activityCount + commentCount;
}

// ─── memberStats ─────────────────────────────────────────────────────────────

export interface MemberStat {
  userId: string;
  userName: string;
  isAgent: boolean;
  tasksCreated: number;
  tasksCompleted: number;
  agentsAssigned: number;
  comments: number;
}

/**
 * Returns per-member aggregated contribution stats for a given server.
 *
 * Each element represents one distinct creator (`createdById`) observed in
 * either workspace_task_activity or workspace_task_comments for the server.
 * Rows with a NULL `createdById` are skipped at the SQL level.
 *
 * `isAgent` is true if ANY of the member's rows have `createdByType = 'agent'`.
 *
 * The display name (`userName`) is resolved as the lexicographic maximum of
 * all `createdByName` values observed for that user, making it stable even
 * when a user renames themselves between rows.
 *
 * Optional `startMs` / `endMs` (millisecond epoch) bound rows by `createdAt`
 * (both ends inclusive).
 *
 * NOTE: activity aggregation and comment aggregation are run in parallel (two
 * GROUP BY queries), then merged in memory by userId.  A UNION-based single
 * query would be more concise but harder to read and offers no meaningful
 * performance gain at current row volumes.
 */
export async function memberStats(
  serverId: string,
  startMs?: number,
  endMs?: number,
): Promise<MemberStat[]> {
  // Build WHERE predicates for each table
  const activityPreds = [eq(workspaceTaskActivity.serverId, serverId)];
  const commentsPreds = [eq(workspaceTaskComments.serverId, serverId)];

  // Exclude rows with NULL createdById at the SQL level so the DB never groups them.
  activityPreds.push(isNotNull(workspaceTaskActivity.createdById));
  commentsPreds.push(isNotNull(workspaceTaskComments.createdById));

  if (startMs !== undefined) {
    activityPreds.push(gte(workspaceTaskActivity.createdAt, new Date(startMs)));
    commentsPreds.push(gte(workspaceTaskComments.createdAt, new Date(startMs)));
  }
  if (endMs !== undefined) {
    activityPreds.push(lte(workspaceTaskActivity.createdAt, new Date(endMs)));
    commentsPreds.push(lte(workspaceTaskComments.createdAt, new Date(endMs)));
  }

  const [activityAgg, commentAgg] = await Promise.all([
    db
      .select({
        userId:         workspaceTaskActivity.createdById,
        userName:       sql<string | null>`max(${workspaceTaskActivity.createdByName}) FILTER (WHERE ${workspaceTaskActivity.createdByName} IS NOT NULL)`,
        isAgent:        sql<boolean>`bool_or(${workspaceTaskActivity.createdByType} = 'agent')`,
        tasksCreated:   sql<number>`count(*) FILTER (WHERE ${workspaceTaskActivity.type} = 'task_created')::int`,
        tasksCompleted: sql<number>`count(*) FILTER (WHERE ${workspaceTaskActivity.type} = 'status_change' AND ${workspaceTaskActivity.metadata}->>'to' = 'done')::int`,
        agentsAssigned: sql<number>`count(*) FILTER (WHERE ${workspaceTaskActivity.type} = 'agent_assigned')::int`,
      })
      .from(workspaceTaskActivity)
      .where(and(...activityPreds))
      .groupBy(workspaceTaskActivity.createdById),
    db
      .select({
        userId:   workspaceTaskComments.createdById,
        userName: sql<string | null>`max(${workspaceTaskComments.createdByName}) FILTER (WHERE ${workspaceTaskComments.createdByName} IS NOT NULL)`,
        isAgent:  sql<boolean>`bool_or(${workspaceTaskComments.createdByType} = 'agent')`,
        comments: sql<number>`count(*)::int`,
      })
      .from(workspaceTaskComments)
      .where(and(...commentsPreds))
      .groupBy(workspaceTaskComments.createdById),
  ]);

  // Merge by userId (include rows from both queries)
  const byUser = new Map<string, MemberStat>();

  for (const a of activityAgg) {
    if (!a.userId) continue;
    byUser.set(a.userId, {
      userId:         a.userId,
      userName:       a.userName ?? '',
      isAgent:        !!a.isAgent,
      tasksCreated:   a.tasksCreated ?? 0,
      tasksCompleted: a.tasksCompleted ?? 0,
      agentsAssigned: a.agentsAssigned ?? 0,
      comments:       0,
    });
  }

  for (const c of commentAgg) {
    if (!c.userId) continue;
    const existing = byUser.get(c.userId);
    if (existing) {
      existing.comments = c.comments ?? 0;
      existing.isAgent  = existing.isAgent || !!c.isAgent;
    } else {
      byUser.set(c.userId, {
        userId:         c.userId,
        userName:       c.userName ?? '',
        isAgent:        !!c.isAgent,
        tasksCreated:   0,
        tasksCompleted: 0,
        agentsAssigned: 0,
        comments:       c.comments ?? 0,
      });
    }
  }

  return Array.from(byUser.values());
}

// ─── memberActivity ───────────────────────────────────────────────────────────

export interface MemberActivityBucket {
  period: string;
  members: Array<{
    userId: string;
    userName: string;
    isAgent: boolean;
    total: number;
    created: number;
    completed: number;
    assigned: number;
    comments: number;
  }>;
}

/**
 * Returns bucketed time-series per-member contribution counts for a given server.
 *
 * Bucketing uses PostgreSQL `date_trunc` on `created_at AT TIME ZONE 'UTC'`,
 * cast to `::date`, producing ISO-8601 date strings (YYYY-MM-DD) as period keys.
 * For `granularity = 'week'` the period is the Monday of that ISO week;
 * for `granularity = 'month'` it is the first day of that month.
 *
 * The `[startMs, endMs]` window is inclusive on both ends (>= and <=).
 * Rows with a NULL `created_by_id` are skipped at the SQL level.
 *
 * The display name (`user_name`) is resolved as `max(created_by_name)` within
 * each (period, user) group so that a user rename between rows does not
 * produce duplicate groups.
 *
 * Implementation runs two queries in parallel (activity + comments) and merges
 * results in memory by (period, userId), matching the pattern established in
 * `memberStats`.  The granularity string is whitelisted to 3 safe values before
 * being inlined as a SQL literal via `sql.raw()` — `date_trunc` requires its
 * first argument to be a string literal, not a bind parameter, so parameterising
 * it would cause a PostgreSQL error.
 */
export async function memberActivity(
  serverId: string,
  startMs: number,
  endMs: number,
  granularity: 'day' | 'week' | 'month',
): Promise<{ buckets: MemberActivityBucket[] }> {
  // `date_trunc` requires its granularity arg to be a literal, not a bind
  // parameter. We whitelist to exactly these three values so sql.raw() is safe.
  const trunc: 'day' | 'week' | 'month' = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';

  type ActivityRow = {
    period: string;
    user_id: string;
    user_name: string | null;
    is_agent: boolean;
    created: number;
    completed: number;
    assigned: number;
  };

  type CommentRow = {
    period: string;
    user_id: string;
    user_name: string | null;
    is_agent: boolean;
    comments: number;
  };

  const [activityResult, commentResult] = await Promise.all([
    db.execute<ActivityRow>(sql`
      SELECT
        date_trunc(${sql.raw(`'${trunc}'`)}, created_at AT TIME ZONE 'UTC')::date AS period,
        created_by_id   AS user_id,
        max(created_by_name) FILTER (WHERE created_by_name IS NOT NULL) AS user_name,
        bool_or(created_by_type = 'agent') AS is_agent,
        count(*) FILTER (WHERE type = 'task_created')::int    AS created,
        count(*) FILTER (WHERE type = 'status_change' AND metadata->>'to' = 'done')::int AS completed,
        count(*) FILTER (WHERE type = 'agent_assigned')::int  AS assigned
      FROM workspace_task_activity
      WHERE server_id     = ${serverId}
        AND created_at   >= ${new Date(startMs)}
        AND created_at   <= ${new Date(endMs)}
        AND created_by_id IS NOT NULL
      GROUP BY period, created_by_id
    `),
    db.execute<CommentRow>(sql`
      SELECT
        date_trunc(${sql.raw(`'${trunc}'`)}, created_at AT TIME ZONE 'UTC')::date AS period,
        created_by_id   AS user_id,
        max(created_by_name) FILTER (WHERE created_by_name IS NOT NULL) AS user_name,
        bool_or(created_by_type = 'agent') AS is_agent,
        count(*)::int AS comments
      FROM workspace_task_comments
      WHERE server_id     = ${serverId}
        AND created_at   >= ${new Date(startMs)}
        AND created_at   <= ${new Date(endMs)}
        AND created_by_id IS NOT NULL
      GROUP BY period, created_by_id
    `),
  ]);

  type MemberEntry = {
    userId: string;
    userName: string;
    isAgent: boolean;
    created: number;
    completed: number;
    assigned: number;
    comments: number;
  };

  // Merge by (period, userId) — outer map keyed by period ISO string,
  // inner map keyed by userId.
  const byPeriod = new Map<string, Map<string, MemberEntry>>();

  for (const row of activityResult.rows) {
    const period = String(row.period);
    if (!byPeriod.has(period)) byPeriod.set(period, new Map());
    const members = byPeriod.get(period)!;

    const existing = members.get(row.user_id);
    if (existing) {
      existing.created   += row.created   ?? 0;
      existing.completed += row.completed ?? 0;
      existing.assigned  += row.assigned  ?? 0;
      existing.isAgent   = existing.isAgent || !!row.is_agent;
    } else {
      members.set(row.user_id, {
        userId:    row.user_id,
        userName:  row.user_name ?? '',
        isAgent:   !!row.is_agent,
        created:   row.created   ?? 0,
        completed: row.completed ?? 0,
        assigned:  row.assigned  ?? 0,
        comments:  0,
      });
    }
  }

  for (const row of commentResult.rows) {
    const period = String(row.period);
    if (!byPeriod.has(period)) byPeriod.set(period, new Map());
    const members = byPeriod.get(period)!;

    const existing = members.get(row.user_id);
    if (existing) {
      existing.comments += row.comments ?? 0;
      existing.isAgent   = existing.isAgent || !!row.is_agent;
    } else {
      members.set(row.user_id, {
        userId:    row.user_id,
        userName:  row.user_name ?? '',
        isAgent:   !!row.is_agent,
        created:   0,
        completed: 0,
        assigned:  0,
        comments:  row.comments ?? 0,
      });
    }
  }

  // Flatten to buckets[], computing total per member, sorted by period ASC.
  const buckets: MemberActivityBucket[] = Array.from(byPeriod.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, members]) => ({
      period,
      members: Array.from(members.values()).map((m) => ({
        ...m,
        total: m.created + m.completed + m.assigned + m.comments,
      })),
    }));

  return { buckets };
}
