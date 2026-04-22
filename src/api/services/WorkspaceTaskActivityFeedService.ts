import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { workspaceTaskActivity, workspaceTaskComments } from '../../db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// listFeed
// ---------------------------------------------------------------------------

/**
 * Returns a server-wide unified activity feed (workspace_task_activity rows
 * merged with workspace_task_comments rows) sorted descending by created_at.
 *
 * `type === 'comment'` is a pseudo-type that surfaces only comment rows.
 * All other type values filter only activity rows.
 *
 * Pagination (limit/offset) is applied after merging and sorting.
 */
export async function listFeed(serverId: string, filters: FeedFilters): Promise<FeedResult> {
  const activityWhere: ReturnType<typeof eq>[] = [eq(workspaceTaskActivity.serverId, serverId)];
  const commentsWhere: ReturnType<typeof eq>[] = [eq(workspaceTaskComments.serverId, serverId)];

  if (filters.userId) {
    activityWhere.push(eq(workspaceTaskActivity.createdById, filters.userId));
    commentsWhere.push(eq(workspaceTaskComments.createdById, filters.userId));
  }

  if (filters.excludeAgents) {
    activityWhere.push(sql`${workspaceTaskActivity.createdByType} <> 'agent'` as any);
    commentsWhere.push(sql`${workspaceTaskComments.createdByType} <> 'agent'` as any);
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
    ...(activityRows as any[]).map((r) => ({
      id: r.id as string,
      todoId: r.taskId as string,
      type: r.type as string,
      content: (r.content ?? null) as string | null,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      attachments: null,
      createdBy: (r.createdById ?? null) as string | null,
      createdByName: (r.createdByName ?? null) as string | null,
      createdAt: (r.createdAt as Date).getTime(),
    })),
    ...(commentRows as any[]).map((r) => ({
      id: r.id as string,
      todoId: r.taskId as string,
      type: 'comment',
      content: r.content as string,
      metadata: null,
      attachments: null,
      createdBy: (r.createdById ?? null) as string | null,
      createdByName: (r.createdByName ?? null) as string | null,
      createdAt: (r.createdAt as Date).getTime(),
    })),
  ];

  // Sort merged set DESC by createdAt
  entries.sort((a, b) => b.createdAt - a.createdAt);

  const total = entries.length;
  const paged = entries.slice(filters.offset, filters.offset + filters.limit);

  return { entries: paged, total, limit: filters.limit, offset: filters.offset };
}
