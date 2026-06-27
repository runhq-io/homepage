import { and, count, eq, gt, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { workspaceTaskActivity, workspaceTaskComments, workspaceTasks } from '../../db/schema';

// Canonicalises a creator's identity. A single human can show up under two
// different `created_by_id` values:
//   • as a logged-in member (`created_by_type = 'member'`, id = `users.id`)
//   • via the public widget (`created_by_type = 'external'`, id = `widget_users.id`)
// `widget_users.external_user_id` links the widget identity back to the
// underlying account. Without this fragment, member/widget activity from the
// same person would render as two separate legend entries with two colours.
//
// The fragment is a SQL string that resolves to the canonical user_id and the
// preferred display name for a row in `workspace_task_activity` /
// `workspace_task_comments`. Callers must alias the source row table as `src`.
const CANONICAL_USER_SQL = {
  joins: sql`
    LEFT JOIN widget_users wu
      ON wu.id::text = src.created_by_id
      AND src.created_by_type = 'external'
    LEFT JOIN users u
      ON u.id::text = COALESCE(wu.external_user_id, src.created_by_id)
  `,
  userId: sql`COALESCE(wu.external_user_id, src.created_by_id)`,
  // Prefer the user's current registered identity over the snapshotted
  // `created_by_name`, so a rename in `users` is reflected immediately and
  // member/widget rows for the same person render under one consistent name.
  userName: sql`COALESCE(
    max(u.username) FILTER (WHERE u.username IS NOT NULL),
    max(u.name)     FILTER (WHERE u.name     IS NOT NULL),
    max(src.created_by_name) FILTER (WHERE src.created_by_name IS NOT NULL)
  )`,
};

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
  /** BE canonical task UUID. Workspace callers translate this to a workspace-local todoId via their exec-state map. */
  canonicalTaskId: string;
  /** Joined from workspace_tasks.title so clients can render a task label without a second round-trip. */
  todoTitle: string | null;
  /** Joined from workspace_tasks.workspace_channel_id so clients can deep-link to the task's channel. */
  todoChannelId: string | null;
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
            todoTitle: workspaceTasks.title,
            todoChannelId: workspaceTasks.workspaceChannelId,
          })
          .from(workspaceTaskActivity)
          .leftJoin(workspaceTasks, eq(workspaceTaskActivity.taskId, workspaceTasks.id))
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
            todoTitle: workspaceTasks.title,
            todoChannelId: workspaceTasks.workspaceChannelId,
          })
          .from(workspaceTaskComments)
          .leftJoin(workspaceTasks, eq(workspaceTaskComments.taskId, workspaceTasks.id))
          .where(and(...commentsWhere))
      : Promise.resolve([]),
  ]);

  const entries: FeedEntry[] = [
    ...activityRows.map((r) => ({
      id: r.id,
      canonicalTaskId: r.taskId,
      todoTitle: r.todoTitle ?? null,
      todoChannelId: r.todoChannelId ?? null,
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
      canonicalTaskId: r.taskId,
      todoTitle: r.todoTitle ?? null,
      todoChannelId: r.todoChannelId ?? null,
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
 * Each element represents one distinct creator, keyed by their canonical
 * identity (see CANONICAL_USER_SQL): member and widget activity from the same
 * person collapses into a single row.  Rows with a NULL `createdById` are
 * skipped at the SQL level.
 *
 * `isAgent` is true if ANY of the member's rows have `createdByType = 'agent'`.
 *
 * The display name (`userName`) prefers the user's current registered name
 * (`users.username || users.name`) and falls back to the snapshotted
 * `createdByName` for entities without a `users` row (agents, anonymous
 * external commenters), so renames in `users` are reflected immediately.
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
  const startCond = startMs !== undefined ? sql`AND src.created_at >= ${new Date(startMs)}` : sql``;
  const endCond   = endMs   !== undefined ? sql`AND src.created_at <= ${new Date(endMs)}`   : sql``;

  type ActivityRow = {
    user_id: string;
    user_name: string | null;
    is_agent: boolean;
    tasks_created: number;
    tasks_completed: number;
    agents_assigned: number;
  };
  type CommentRow = {
    user_id: string;
    user_name: string | null;
    is_agent: boolean;
    comments: number;
  };

  const [activityResult, commentResult] = await Promise.all([
    db.execute<ActivityRow>(sql`
      SELECT
        ${CANONICAL_USER_SQL.userId} AS user_id,
        ${CANONICAL_USER_SQL.userName} AS user_name,
        bool_or(src.created_by_type = 'agent') AS is_agent,
        count(*) FILTER (WHERE src.type = 'task_created')::int AS tasks_created,
        count(*) FILTER (WHERE src.type = 'status_change' AND src.metadata->>'to' IN ('done', 'deployed', 'cancelled'))::int AS tasks_completed,
        count(*) FILTER (WHERE src.type = 'agent_assigned')::int AS agents_assigned
      FROM workspace_task_activity src
      ${CANONICAL_USER_SQL.joins}
      WHERE src.server_id     = ${serverId}
        AND src.created_by_id IS NOT NULL
        ${startCond}
        ${endCond}
      GROUP BY ${CANONICAL_USER_SQL.userId}
    `),
    db.execute<CommentRow>(sql`
      SELECT
        ${CANONICAL_USER_SQL.userId} AS user_id,
        ${CANONICAL_USER_SQL.userName} AS user_name,
        bool_or(src.created_by_type = 'agent') AS is_agent,
        count(*)::int AS comments
      FROM workspace_task_comments src
      ${CANONICAL_USER_SQL.joins}
      WHERE src.server_id     = ${serverId}
        AND src.created_by_id IS NOT NULL
        ${startCond}
        ${endCond}
      GROUP BY ${CANONICAL_USER_SQL.userId}
    `),
  ]);

  // Merge by canonical userId (include rows from both queries)
  const byUser = new Map<string, MemberStat>();

  for (const a of activityResult.rows) {
    if (!a.user_id) continue;
    byUser.set(a.user_id, {
      userId:         a.user_id,
      userName:       a.user_name ?? '',
      isAgent:        !!a.is_agent,
      tasksCreated:   a.tasks_created ?? 0,
      tasksCompleted: a.tasks_completed ?? 0,
      agentsAssigned: a.agents_assigned ?? 0,
      comments:       0,
    });
  }

  for (const c of commentResult.rows) {
    if (!c.user_id) continue;
    const existing = byUser.get(c.user_id);
    if (existing) {
      existing.comments = c.comments ?? 0;
      existing.isAgent  = existing.isAgent || !!c.is_agent;
      // Activity-side userName takes precedence (richer name pool); only fall
      // back to the comment-side name if activity never resolved a name.
      if (!existing.userName && c.user_name) existing.userName = c.user_name;
    } else {
      byUser.set(c.user_id, {
        userId:         c.user_id,
        userName:       c.user_name ?? '',
        isAgent:        !!c.is_agent,
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
 * The display name (`user_name`) prefers the user's current registered name
 * from the `users` table (see CANONICAL_USER_SQL); snapshotted
 * `created_by_name` is only used for entities without a `users` row.
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
        date_trunc(${sql.raw(`'${trunc}'`)}, src.created_at AT TIME ZONE 'UTC')::date AS period,
        ${CANONICAL_USER_SQL.userId} AS user_id,
        ${CANONICAL_USER_SQL.userName} AS user_name,
        bool_or(src.created_by_type = 'agent') AS is_agent,
        count(*) FILTER (WHERE src.type = 'task_created')::int    AS created,
        count(*) FILTER (WHERE src.type = 'status_change' AND src.metadata->>'to' IN ('done', 'deployed', 'cancelled'))::int AS completed,
        count(*) FILTER (WHERE src.type = 'agent_assigned')::int  AS assigned
      FROM workspace_task_activity src
      ${CANONICAL_USER_SQL.joins}
      WHERE src.server_id     = ${serverId}
        AND src.created_at   >= ${new Date(startMs)}
        AND src.created_at   <= ${new Date(endMs)}
        AND src.created_by_id IS NOT NULL
      GROUP BY period, ${CANONICAL_USER_SQL.userId}
    `),
    db.execute<CommentRow>(sql`
      SELECT
        date_trunc(${sql.raw(`'${trunc}'`)}, src.created_at AT TIME ZONE 'UTC')::date AS period,
        ${CANONICAL_USER_SQL.userId} AS user_id,
        ${CANONICAL_USER_SQL.userName} AS user_name,
        bool_or(src.created_by_type = 'agent') AS is_agent,
        count(*)::int AS comments
      FROM workspace_task_comments src
      ${CANONICAL_USER_SQL.joins}
      WHERE src.server_id     = ${serverId}
        AND src.created_at   >= ${new Date(startMs)}
        AND src.created_at   <= ${new Date(endMs)}
        AND src.created_by_id IS NOT NULL
      GROUP BY period, ${CANONICAL_USER_SQL.userId}
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
