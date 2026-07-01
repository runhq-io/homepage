import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  workspaceTasks,
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  workspaceTaskVotes,
  widgetProjects,
  widgetUsers,
  type WorkspaceTask,
} from '../../db/schema';
import { emitTaskNotification, type NotificationActor } from '../../notifications/emitTaskNotification';
import { dispatchNotification } from '../../notifications/dispatch';
import { publishTicketUpdate } from './WidgetTicketEvents';
import type {
  ActivityType,
  CanonicalTaskAttachment,
  CanonicalTaskAttachmentInput,
  CanonicalTask,
  CanonicalTaskActivityEntry,
  CanonicalTaskComment,
  CanonicalTaskMigrationBundle,
  CanonicalTaskMigrationResult,
  CanonicalTaskMigrationSummary,
  CanonicalTaskVisibility,
  CanonicalTaskSourceType,
  CanonicalTaskType,
  CanonicalTaskStatus,
} from '@runhq/server-protocol';
import { TaskAttachmentStorageService } from './TaskAttachmentStorageService';
// Shared instance wired to real WS broadcasting (see communityServices/communityBroadcaster).
// This is the single canonical awarding path: every task status update flows through updateTask.
import { communityPointsService } from './communityServices';

type CreateWorkspaceTaskInput = {
  workspaceProjectId?: string | null;
  workspaceChannelId?: string | null;
  title: string;
  description?: string | null;
  status?: CanonicalTaskStatus;
  visibility?: CanonicalTaskVisibility;
  sourceType?: CanonicalTaskSourceType;
  createdByType?: 'member' | 'external' | 'system' | 'agent';
  createdById?: string | null;
  createdByName?: string | null;
  commentsDisabled?: boolean;
  useWorktree?: boolean;
  type?: CanonicalTaskType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  completedAt?: string | Date | null;
  archivedAt?: string | Date | null;
  deletedAt?: string | Date | null;
  upvoteCount?: number;
  moderationStatus?: 'pending' | 'approved' | 'rejected';
  legacyWorkspaceTodoId?: string | null;
  attachments?: CanonicalTaskAttachmentInput[] | null;
  isPublished?: boolean;
};

type UpdateWorkspaceTaskInput = Partial<CreateWorkspaceTaskInput> & {
  /** When provided, stamps last_interactor_user_id + last_interactor_at on the row. null clears both. */
  lastInteractorUserId?: string | null;
  /** Workspace job/session bound to this task right now. Not persisted on the
   *  task row — the binding lives on the workspace server's execution-state
   *  table and may move between jobs over time. Snapshot at emit time onto
   *  the notification so a click can deep-link to the running session. */
  workspaceJobId?: string | null;
  /** Human-readable project name resolved on the workspace server. Not
   *  persisted on the canonical task; snapshotted at emit time onto the
   *  notification so the bell shows "MiniCal · Mobile" instead of
   *  "MiniCal · tank_abc123". */
  workspaceProjectName?: string | null;
};

const attachmentStorage = new TaskAttachmentStorageService();

function toIso(value?: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function fromEpochMs(value?: number | null): Date | null {
  if (value === undefined || value === null) return null;
  return new Date(value);
}

async function toCanonicalAttachment(row: typeof workspaceTaskAttachments.$inferSelect): Promise<CanonicalTaskAttachment> {
  return {
    id: row.id,
    taskId: row.taskId,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    storageProvider: row.storageProvider,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    originalName: row.originalName,
    legacyWorkspaceAttachmentKey: row.legacyWorkspaceAttachmentKey,
    url: await attachmentStorage.createDownloadUrl({
      storageProvider: row.storageProvider,
      storageKey: row.storageKey,
      originalName: row.originalName,
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

type TaskAttachmentGroup = {
  task: CanonicalTaskAttachment[];
  byOwnerId: Map<string, CanonicalTaskAttachment[]>;
};

async function loadTaskAttachmentGroups(taskIds: string[]): Promise<Map<string, TaskAttachmentGroup>> {
  if (taskIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(workspaceTaskAttachments)
    .where(inArray(workspaceTaskAttachments.taskId, taskIds))
    .orderBy(asc(workspaceTaskAttachments.createdAt));

  const canonicalRows = await Promise.all(rows.map((row) => toCanonicalAttachment(row)));
  const groups = new Map<string, TaskAttachmentGroup>();

  for (const attachment of canonicalRows) {
    let group = groups.get(attachment.taskId);
    if (!group) {
      group = { task: [], byOwnerId: new Map() };
      groups.set(attachment.taskId, group);
    }

    if (attachment.ownerType === 'task') {
      group.task.push(attachment);
      continue;
    }

    const ownerAttachments = group.byOwnerId.get(attachment.ownerId) ?? [];
    ownerAttachments.push(attachment);
    group.byOwnerId.set(attachment.ownerId, ownerAttachments);
  }

  return groups;
}

function toCanonicalTask(row: WorkspaceTask, attachments?: CanonicalTaskAttachment[] | null): CanonicalTask {
  return {
    id: row.id,
    serverId: row.serverId,
    workspaceProjectId: row.workspaceProjectId,
    workspaceChannelId: row.workspaceChannelId,
    title: row.title,
    description: row.description,
    status: row.status as CanonicalTaskStatus,
    visibility: row.visibility as CanonicalTaskVisibility,
    isPublished: row.isPublished,
    sourceType: row.sourceType as CanonicalTaskSourceType,
    createdByType: row.createdByType as CanonicalTask['createdByType'],
    createdById: row.createdById,
    createdByName: row.createdByName,
    commentsDisabled: row.commentsDisabled,
    useWorktree: row.useWorktree,
    type: row.taskType as CanonicalTaskType,
    schedule: row.schedule,
    scheduledAt: row.scheduledAt ?? null,
    timezone: row.timezone,
    completedAt: toIso(row.completedAt),
    archivedAt: toIso(row.archivedAt),
    deletedAt: toIso(row.deletedAt),
    legacyWorkspaceTodoId: row.legacyWorkspaceTodoId,
    upvoteCount: row.upvoteCount,
    downvoteCount: row.downvoteCount,
    moderationStatus: row.moderationStatus as 'pending' | 'approved' | 'rejected',
    votingEndsAt: toIso(row.votingEndsAt),
    upvotedByMe: false,
    attachments: attachments ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

async function loadTaskVoteMap(
  taskIds: string[],
  viewerId?: string | null,
  viewerType: 'member' | 'external' = 'member',
): Promise<Map<string, boolean>> {
  if (!viewerId || taskIds.length === 0) return new Map();

  const rows = await db
    .select({
      taskId: workspaceTaskVotes.taskId,
      value: workspaceTaskVotes.value,
    })
    .from(workspaceTaskVotes)
    .where(and(
      inArray(workspaceTaskVotes.taskId, taskIds),
      eq(workspaceTaskVotes.voterId, viewerId),
      eq(workspaceTaskVotes.voterType, viewerType),
    ));

  return new Map(rows.map((row) => [row.taskId, row.value]));
}

function toCanonicalComment(
  row: typeof workspaceTaskComments.$inferSelect,
  attachments?: CanonicalTaskAttachment[] | null,
): CanonicalTaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    content: row.content,
    createdByType: row.createdByType as CanonicalTaskComment['createdByType'],
    createdById: row.createdById,
    createdByName: row.createdByName,
    legacyWorkspaceCommentId: row.legacyWorkspaceCommentId,
    attachments: attachments ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: toIso(row.deletedAt),
  };
}

function toCanonicalActivity(
  row: typeof workspaceTaskActivity.$inferSelect,
  attachments?: CanonicalTaskAttachment[] | null,
): CanonicalTaskActivityEntry {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type as ActivityType,
    content: row.content,
    metadata: (row.metadata as Record<string, any> | null) ?? null,
    createdByType: row.createdByType as CanonicalTaskActivityEntry['createdByType'],
    createdById: row.createdById,
    createdByName: row.createdByName,
    legacyWorkspaceActivityId: row.legacyWorkspaceActivityId,
    attachments: attachments ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTasksByServer(
  serverId: string,
  options?: {
    visibility?: CanonicalTaskVisibility;
    includeDeleted?: boolean;
    workspaceProjectId?: string;
    workspaceChannelId?: string;
    includeAttachments?: boolean;
    viewerId?: string | null;
    viewerType?: 'member' | 'external';
  },
): Promise<CanonicalTask[]> {
  const conditions = [eq(workspaceTasks.serverId, serverId)];
  if (options?.visibility) conditions.push(eq(workspaceTasks.visibility, options.visibility));
  if (options?.workspaceProjectId) conditions.push(eq(workspaceTasks.workspaceProjectId, options.workspaceProjectId));
  if (options?.workspaceChannelId) conditions.push(eq(workspaceTasks.workspaceChannelId, options.workspaceChannelId));
  if (!options?.includeDeleted) conditions.push(isNull(workspaceTasks.deletedAt));
  const rows = await db
    .select()
    .from(workspaceTasks)
    .where(and(...conditions))
    .orderBy(desc(workspaceTasks.updatedAt));
  const attachmentGroups = options?.includeAttachments
    ? await loadTaskAttachmentGroups(rows.map((row) => row.id))
    : new Map<string, TaskAttachmentGroup>();
  const voteMap = await loadTaskVoteMap(rows.map((row) => row.id), options?.viewerId, options?.viewerType ?? 'member');
  return rows.map((row) => ({
    ...toCanonicalTask(row, attachmentGroups.get(row.id)?.task ?? null),
    upvotedByMe: voteMap.get(row.id) ?? false,
  }));
}

// ============================================================================
// Task share-link resolution
// ============================================================================
//
// A task share-link is minted client-side as `app.runhq.io/task/<shortId>`,
// where `<shortId>` is the first 8 hex chars of the task UUID (git-style short
// id). Old links use `/?todo=<full-uuid>`. Neither form carries server context,
// so the web app asks the cloud — which mirrors every task in `workspace_tasks`
// — to resolve the id to its owning server + channel before routing.
//
// The id in a link may be the canonical cloud id (newer tasks) or the original
// per-workspace todo id (`legacyWorkspaceTodoId`, for tasks migrated from the
// legacy todos table), so we match on either column.

/** A classified, validated task share-link id. */
export type TaskShareIdQuery =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string };

/** A task row that matched a share-link id, before access filtering. */
export interface TaskCandidate {
  serverId: string;
  channelId: string | null;
  taskId: string;
  title: string;
  legacyWorkspaceTodoId: string | null;
  /** Epoch ms — used only for a deterministic tiebreak on prefix collisions. */
  createdAt: number;
}

/** The routing tuple returned to the client once a task is resolved. */
export interface ResolvedTask {
  serverId: string;
  channelId: string | null;
  taskId: string;
  title: string;
}

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_PREFIX_RE = /^[0-9a-f]{4,32}$/;

/**
 * Classify a raw share-link id into a DB query, or null if it isn't a plausible
 * task id (rejects garbage / path-traversal before it ever reaches SQL). A full
 * UUID resolves exactly; a 4–32 char hex string is treated as an id prefix.
 */
export function parseTaskShareId(input: string): TaskShareIdQuery | null {
  const v = input.trim().toLowerCase();
  if (FULL_UUID_RE.test(v)) return { kind: 'exact', value: v };
  if (HEX_PREFIX_RE.test(v)) return { kind: 'prefix', value: v };
  return null;
}

/**
 * Given the candidate rows that matched a share-link id and the set of servers
 * the caller can reach, pick the one task to route to.
 *
 * - Filters to reachable servers first (a task on a server the user can't see is
 *   invisible — the endpoint returns 404, never leaking its existence).
 * - Exactly one reachable match → resolve it.
 * - Multiple reachable matches (an 8-char prefix collision among the user's own
 *   tasks — astronomically rare): prefer an exact id/legacy-id match when the
 *   input was a full id, else the deterministically-oldest task. `ambiguous` is
 *   surfaced so the caller can log it.
 */
export function selectResolvedTask(
  candidates: TaskCandidate[],
  accessibleServerIds: Set<string>,
  query: TaskShareIdQuery,
): { resolved: ResolvedTask | null; ambiguous: boolean } {
  const toResolved = (c: TaskCandidate): ResolvedTask => ({
    serverId: c.serverId,
    channelId: c.channelId,
    taskId: c.taskId,
    title: c.title,
  });

  const reachable = candidates.filter((c) => accessibleServerIds.has(c.serverId));
  if (reachable.length === 0) return { resolved: null, ambiguous: false };
  if (reachable.length === 1) return { resolved: toResolved(reachable[0]), ambiguous: false };

  if (query.kind === 'exact') {
    const exact = reachable.find(
      (c) => c.taskId === query.value || c.legacyWorkspaceTodoId === query.value,
    );
    if (exact) return { resolved: toResolved(exact), ambiguous: true };
  }

  const oldest = [...reachable].sort(
    (a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId),
  )[0];
  return { resolved: toResolved(oldest), ambiguous: true };
}

/**
 * Fetch the non-deleted task rows matching a share-link id query. No access
 * control — the caller filters by reachable servers via {@link selectResolvedTask}.
 * Capped at 16 rows; a real prefix never collides beyond a handful.
 */
export async function resolveTaskCandidates(query: TaskShareIdQuery): Promise<TaskCandidate[]> {
  const match =
    query.kind === 'exact'
      ? or(eq(workspaceTasks.id, query.value), eq(workspaceTasks.legacyWorkspaceTodoId, query.value))
      : or(
          sql`${workspaceTasks.id}::text LIKE ${query.value + '%'}`,
          sql`${workspaceTasks.legacyWorkspaceTodoId} LIKE ${query.value + '%'}`,
        );

  const rows = await db
    .select({
      serverId: workspaceTasks.serverId,
      channelId: workspaceTasks.workspaceChannelId,
      taskId: workspaceTasks.id,
      title: workspaceTasks.title,
      legacyWorkspaceTodoId: workspaceTasks.legacyWorkspaceTodoId,
      createdAt: workspaceTasks.createdAt,
    })
    .from(workspaceTasks)
    .where(and(match, isNull(workspaceTasks.deletedAt)))
    .limit(16);

  return rows.map((r) => ({
    serverId: r.serverId,
    channelId: r.channelId ?? null,
    taskId: r.taskId,
    title: r.title,
    legacyWorkspaceTodoId: r.legacyWorkspaceTodoId ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
  }));
}

export async function getTaskById(
  serverId: string,
  taskId: string,
  options?: {
    includeAttachments?: boolean;
    viewerId?: string | null;
    viewerType?: 'member' | 'external';
  },
): Promise<CanonicalTask | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    return null;
  }
  const [row] = await db
    .select()
    .from(workspaceTasks)
    .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
    .limit(1);
  if (!row) return null;
  const attachmentGroups = options?.includeAttachments ? await loadTaskAttachmentGroups([row.id]) : null;
  const voteMap = await loadTaskVoteMap([row.id], options?.viewerId, options?.viewerType ?? 'member');
  return {
    ...toCanonicalTask(row, attachmentGroups?.get(row.id)?.task ?? null),
    upvotedByMe: voteMap.get(row.id) ?? false,
  };
}

export function resolveCreateIsPublished(
  input: { sourceType?: CanonicalTaskSourceType; isPublished?: boolean },
): boolean {
  if (input.isPublished !== undefined) return input.isPublished;
  // All tasks default to published. Visibility (public/private) is the gate
  // for who can see them — the published feed always also requires
  // visibility='public', so a private+published task never leaks. Widget
  // submissions used to default unpublished, which made tickets vanish once
  // their status left the pending set (they never entered the "Latest
  // Updates" feed). Published-by-default keeps them visible through 'done'.
  return true;
}

export async function createTask(serverId: string, input: CreateWorkspaceTaskInput): Promise<CanonicalTask> {
  const [row] = await db
    .insert(workspaceTasks)
    .values({
      serverId,
      workspaceProjectId: input.workspaceProjectId ?? null,
      workspaceChannelId: input.workspaceChannelId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'pending',
      visibility: input.visibility ?? 'private',
      isPublished: resolveCreateIsPublished(input),
      sourceType: input.sourceType ?? 'workspace',
      createdByType: input.createdByType ?? 'member',
      createdById: input.createdById ?? null,
      createdByName: input.createdByName ?? null,
      commentsDisabled: input.commentsDisabled ?? false,
      useWorktree: input.useWorktree ?? false,
      taskType: input.type ?? 'regular',
      schedule: input.schedule ?? null,
      scheduledAt: input.scheduledAt ?? null,
      timezone: input.timezone ?? null,
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
      archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
      deletedAt: input.deletedAt ? new Date(input.deletedAt) : null,
      upvoteCount: input.upvoteCount ?? 0,
      legacyWorkspaceTodoId: input.legacyWorkspaceTodoId ?? null,
      lastMigratedAt: input.legacyWorkspaceTodoId ? new Date() : null,
      updatedAt: new Date(),
    })
    .returning();
  if (input.attachments?.length) {
    await replaceTaskAttachments(serverId, row.id, input.attachments);
  }
  const attachmentGroups = input.attachments?.length ? await loadTaskAttachmentGroups([row.id]) : null;
  return toCanonicalTask(row, attachmentGroups?.get(row.id)?.task ?? null);
}

// When isPublished is being set true, the task must be publicly visible.
// Returns the visibility to write, or undefined to leave visibility untouched.
// An explicit visibility in the same payload always wins.
export function resolvePublishVisibility(
  input: { isPublished?: boolean; visibility?: 'public' | 'private' },
  existingVisibility: 'public' | 'private',
): 'public' | 'private' | undefined {
  if (input.visibility !== undefined) return input.visibility;
  if (input.isPublished === true && existingVisibility !== 'public') return 'public';
  return undefined;
}

export async function updateTask(
  serverId: string,
  taskId: string,
  input: UpdateWorkspaceTaskInput,
  actor: NotificationActor = { type: 'system' },
): Promise<{ task: CanonicalTask | null; notification: import('../../notifications/serialize').SerializedNotification | null }> {
  let resultTask: CanonicalTask | null = null;
  let emittedNotificationId: string | null = null;
  // Captured inside the task-update transaction, consumed AFTER it commits so
  // that notification emission can never roll back a status change (and a
  // missing-table / notification error never blocks the core task update).
  type PendingEmit = {
    rowShape: import('../../notifications/emitTaskNotification').TaskRowForNotification;
    prevShape: import('../../notifications/emitTaskNotification').TaskRowForNotification;
    status: 'done' | 'reviewed' | 'merged';
  };
  let pendingEmit: PendingEmit | null = null;
  // Community-points awarding payload, captured in-transaction and fired
  // post-commit — same discipline as pendingEmit: best-effort, must never roll
  // back the authoritative task-status update. This is the single canonical
  // awarding path (every task status change flows through updateTask).
  type PendingAward = { row: WorkspaceTask; oldStatus: string; newStatus: string };
  let pendingAward: PendingAward | null = null;

  await db.transaction(async (tx) => {
    // Fetch the existing row for visibility comparison and status-transition detection.
    const existingRows = await tx
      .select()
      .from(workspaceTasks)
      .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
      .limit(1);
    if (existingRows.length === 0) return; // task not found — resultTask stays null
    const existing = existingRows[0];
    const existingVisibility = existing.visibility as 'public' | 'private';

    // Detect whether this update will transition the task to a notification-worthy
    // status. In the PR lifecycle the recipient cares about the review/merge
    // milestones: `done` (PR up, awaiting review), `reviewed` (approved), and
    // `merged` (landed in base). `needs_review` was folded into `done`.
    const willTransition =
      (input.status === 'done' || input.status === 'reviewed' || input.status === 'merged') &&
      input.status !== existing.status;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.workspaceProjectId !== undefined) updates.workspaceProjectId = input.workspaceProjectId;
    if (input.workspaceChannelId !== undefined) updates.workspaceChannelId = input.workspaceChannelId;
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.status !== undefined) updates.status = input.status;
    if (input.visibility !== undefined) updates.visibility = input.visibility;
    if (input.isPublished !== undefined) updates.isPublished = input.isPublished;
    const promotedVisibility = resolvePublishVisibility(input, existingVisibility);
    if (promotedVisibility !== undefined) updates.visibility = promotedVisibility;
    if (input.sourceType !== undefined) updates.sourceType = input.sourceType;
    if (input.createdByType !== undefined) updates.createdByType = input.createdByType;
    if (input.createdById !== undefined) updates.createdById = input.createdById;
    if (input.createdByName !== undefined) updates.createdByName = input.createdByName;
    if (input.commentsDisabled !== undefined) updates.commentsDisabled = input.commentsDisabled;
    if (input.type !== undefined) updates.taskType = input.type;
    if (input.schedule !== undefined) updates.schedule = input.schedule;
    if (input.scheduledAt !== undefined) updates.scheduledAt = input.scheduledAt;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.completedAt !== undefined) updates.completedAt = input.completedAt ? new Date(input.completedAt) : null;
    if (input.archivedAt !== undefined) updates.archivedAt = input.archivedAt ? new Date(input.archivedAt) : null;
    if (input.deletedAt !== undefined) updates.deletedAt = input.deletedAt ? new Date(input.deletedAt) : null;
    if (input.upvoteCount !== undefined) updates.upvoteCount = input.upvoteCount;
    if (input.moderationStatus !== undefined) updates.moderationStatus = input.moderationStatus;
    if (input.lastInteractorUserId !== undefined) {
      updates.lastInteractorUserId = input.lastInteractorUserId;
      updates.lastInteractorAt = input.lastInteractorUserId !== null ? new Date() : null;
    }

    const [row] = await tx
      .update(workspaceTasks)
      .set(updates)
      .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
      .returning();
    if (!row) return;

    // Capture a community-awarding payload on any real status transition.
    // Eligibility (widget source, terminal-success, no double-award) is decided
    // later by the awarding policy; here we only need the before/after statuses.
    if (input.status !== undefined && existing.status !== row.status) {
      pendingAward = { row, oldStatus: existing.status, newStatus: row.status };
    }

    // Capture the data needed to emit a notification. We do NOT emit inside
    // this transaction: notification delivery is best-effort and must never
    // roll back the authoritative task-status update (e.g. if the notification
    // tables are missing mid-migration, or any emit error occurs).
    if (willTransition) {
      pendingEmit = {
        prevShape: {
          id: existing.id,
          serverId: existing.serverId,
          workspaceProjectId: existing.workspaceProjectId,
          workspaceChannelId: existing.workspaceChannelId,
          workspaceJobId: input.workspaceJobId ?? null,
          workspaceProjectName: input.workspaceProjectName ?? null,
          title: existing.title,
          createdById: existing.createdById,
          lastInteractorUserId: existing.lastInteractorUserId,
        },
        rowShape: {
          id: row.id,
          serverId: row.serverId,
          workspaceProjectId: row.workspaceProjectId,
          workspaceChannelId: row.workspaceChannelId,
          workspaceJobId: input.workspaceJobId ?? null,
          workspaceProjectName: input.workspaceProjectName ?? null,
          title: row.title,
          createdById: row.createdById,
          lastInteractorUserId: row.lastInteractorUserId,
        },
        status: input.status as 'done' | 'reviewed' | 'merged',
      };
    }

    if (input.attachments !== undefined) {
      await replaceTaskAttachments(serverId, row.id, input.attachments ?? []);
    }
    const attachmentGroups = await loadTaskAttachmentGroups([row.id]);
    resultTask = toCanonicalTask(row, attachmentGroups.get(row.id)?.task ?? null);
  });

  // Emit + dispatch the notification AFTER the task-update transaction has
  // committed, in its own transaction, fully wrapped in try/catch. A failure
  // here (missing table, DB blip, etc.) is logged and swallowed — the task
  // update has already succeeded and must not be undone.
  if (pendingEmit) {
    const emit: PendingEmit = pendingEmit;
    try {
      await db.transaction(async (tx) => {
        const notificationId = await emitTaskNotification(tx, emit.rowShape, emit.prevShape, emit.status, actor);
        if (notificationId) emittedNotificationId = notificationId;
      });
      if (emittedNotificationId) {
        void dispatchNotification(emittedNotificationId).catch((err) =>
          console.warn('[WorkspaceTaskService] post-commit dispatch failed', err),
        );
      }
    } catch (err) {
      console.error('[WorkspaceTaskService] notification emit failed (task update preserved)', err);
    }
  }
  // Fire community awarding AFTER the task-update transaction commits —
  // best-effort, never blocks or rolls back the status update.
  if (pendingAward) {
    const award: PendingAward = pendingAward;
    try {
      await triggerCommunityAwarding(award.row, award.oldStatus, award.newStatus);
    } catch (err) {
      console.error('[WorkspaceTaskService] community awarding failed', { taskId, err });
    }
  }

  // If a notification was emitted, fetch the full row so the caller can ship
  // it down to clients (via the existing per-server WS) for sub-second push
  // without a separate browser-to-BE WebSocket connection.
  let emittedNotification: import('../../notifications/serialize').SerializedNotification | null = null;
  if (emittedNotificationId) {
    const { serializeNotification } = await import('../../notifications/serialize');
    const { notifications } = await import('../../db/schema');
    const found = await db.query.notifications.findFirst({ where: eq(notifications.id, emittedNotificationId) });
    if (found) emittedNotification = serializeNotification(found);
  }

  // Push the change to any live widget ticket-status SSE subscribers. The task
  // write is already committed; this is best-effort and must never throw.
  if (resultTask) {
    try { publishTicketUpdate(taskId); } catch (err) {
      console.warn('[WorkspaceTaskService] publishTicketUpdate failed', err);
    }
  }

  return { task: resultTask, notification: emittedNotification };
}

/**
 * Resolves the data needed by CommunityPointsService.awardForCompletion and calls it.
 *
 * sourceType mapping: 'workspace' (DB) → 'native' (policy); 'widget' (DB) → 'widget' (policy).
 *
 * externalUserId resolution: for widget tasks, workspace_tasks.createdById holds a
 * widgetUsers.id UUID. We JOIN through widgetUsers to get externalUserId (the JWT sub).
 *
 * projectId resolution: workspace_tasks has no direct widgetProjectId. We look up
 * widgetProjects by (serverId, channelId) matching the task. If a server has multiple
 * widget projects, we pick the one whose channelId matches the task's workspaceChannelId;
 * if no channelId filter is set on the project, fall back to any project on the server.
 *
 * selfUpvoted: true if a workspace_task_vote row exists where voterId = task.createdById
 * and voterType = 'external' (i.e. the widget-user creator voted for their own ticket).
 *
 * upvoteCountAtTransition: taken directly from the post-update row.upvoteCount, which is
 * kept current by recountTaskUpvotes after every vote change.
 */
async function triggerCommunityAwarding(
  row: WorkspaceTask,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  // Map DB sourceType → policy sourceType
  const sourceType: 'native' | 'widget' = row.sourceType === 'widget' ? 'widget' : 'native';

  // Resolve externalUserId and projectId for widget tasks
  let externalUserId: string | null = null;
  let projectId: string | null = null;

  if (sourceType === 'widget' && row.createdById) {
    // createdById for widget tasks is the widgetUsers.id UUID
    const [widgetUser] = await db
      .select({
        externalUserId: widgetUsers.externalUserId,
        projectId: widgetUsers.projectId,
      })
      .from(widgetUsers)
      .where(eq(widgetUsers.id, row.createdById))
      .limit(1);

    if (widgetUser) {
      externalUserId = widgetUser.externalUserId;
      projectId = widgetUser.projectId;
    }

    // If we couldn't resolve via widgetUsers (e.g. legacy task), fall back to
    // looking up widgetProjects by serverId + channelId.
    if (!projectId) {
      const conditions = [eq(widgetProjects.serverId, row.serverId)];
      if (row.workspaceChannelId) {
        conditions.push(eq(widgetProjects.channelId, row.workspaceChannelId));
      }
      const [project] = await db
        .select({ id: widgetProjects.id })
        .from(widgetProjects)
        .where(and(...conditions))
        .limit(1);
      projectId = project?.id ?? null;
    }
  }

  // Determine if the creator self-upvoted (only meaningful for widget tasks)
  let selfUpvoted = false;
  if (sourceType === 'widget' && row.createdById) {
    const [selfVote] = await db
      .select({ id: workspaceTaskVotes.id })
      .from(workspaceTaskVotes)
      .where(and(
        eq(workspaceTaskVotes.taskId, row.id),
        eq(workspaceTaskVotes.voterId, row.createdById),
        eq(workspaceTaskVotes.voterType, 'external'),
        eq(workspaceTaskVotes.value, true),
      ))
      .limit(1);
    selfUpvoted = !!selfVote;
  }

  await communityPointsService.awardForCompletion({
    ticketId: row.id,
    projectId: projectId ?? '',
    sourceType,
    externalUserId,
    oldStatus: oldStatus as Parameters<typeof communityPointsService.awardForCompletion>[0]['oldStatus'],
    newStatus: newStatus as Parameters<typeof communityPointsService.awardForCompletion>[0]['newStatus'],
    upvoteCountAtTransition: row.upvoteCount,
    selfUpvoted,
    occurredAt: new Date().toISOString(),
  });
}

export async function listComments(taskId: string): Promise<CanonicalTaskComment[]> {
  const rows = await db
    .select()
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.taskId, taskId),
      isNull(workspaceTaskComments.deletedAt),
    ))
    .orderBy(workspaceTaskComments.createdAt);
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  const group = attachmentGroups.get(taskId);
  return rows.map((row) => toCanonicalComment(row, group?.byOwnerId.get(row.id) ?? null));
}

export async function addComment(
  serverId: string,
  taskId: string,
  input: {
    content: string;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
    attachments?: CanonicalTaskAttachmentInput[] | null;
  },
): Promise<CanonicalTaskComment> {
  const [row] = await db
    .insert(workspaceTaskComments)
    .values({
      serverId,
      taskId,
      content: input.content,
      createdByType: input.createdByType ?? 'member',
      createdById: input.createdById ?? null,
      createdByName: input.createdByName ?? null,
      updatedAt: new Date(),
    })
    .returning();
  if (input.attachments?.length) {
    await insertOwnerAttachments(serverId, taskId, 'comment', row.id, input.attachments);
  }
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  return toCanonicalComment(row, attachmentGroups.get(taskId)?.byOwnerId.get(row.id) ?? null);
}

export async function updateComment(
  serverId: string,
  taskId: string,
  commentId: string,
  input: { content: string },
): Promise<CanonicalTaskComment | null> {
  const [row] = await db
    .update(workspaceTaskComments)
    .set({ content: input.content, updatedAt: new Date() })
    .where(and(
      eq(workspaceTaskComments.serverId, serverId),
      eq(workspaceTaskComments.taskId, taskId),
      eq(workspaceTaskComments.id, commentId),
      isNull(workspaceTaskComments.deletedAt),
    ))
    .returning();
  if (!row) return null;
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  return toCanonicalComment(row, attachmentGroups.get(taskId)?.byOwnerId.get(row.id) ?? null);
}

export type DeleteCommentResult = 'deleted' | 'not_found' | 'forbidden';

/**
 * Delete a comment. The actor must be the original author (member-typed) of
 * the comment. Pass `{ override: true }` for trusted internal callers (e.g. an
 * admin/moderator pathway) that have already authorized the deletion.
 */
export async function deleteComment(
  serverId: string,
  taskId: string,
  commentId: string,
  authorization: {
    actorId: string;
    actorType: 'member' | 'external' | 'system' | 'agent';
    override?: boolean;
  },
): Promise<DeleteCommentResult> {
  const [comment] = await db
    .select()
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.serverId, serverId),
      eq(workspaceTaskComments.taskId, taskId),
      eq(workspaceTaskComments.id, commentId),
      isNull(workspaceTaskComments.deletedAt),
    ))
    .limit(1);

  if (!comment) return 'not_found';

  if (!authorization.override) {
    const isAuthor =
      comment.createdByType === authorization.actorType &&
      comment.createdById === authorization.actorId;
    if (!isAuthor) return 'forbidden';
  }

  const attachments = await db
    .select()
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.taskId, taskId),
      eq(workspaceTaskAttachments.ownerType, 'comment'),
      eq(workspaceTaskAttachments.ownerId, commentId),
    ));

  await db
    .delete(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.serverId, serverId),
      eq(workspaceTaskComments.taskId, taskId),
      eq(workspaceTaskComments.id, commentId),
    ));

  await db
    .delete(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.taskId, taskId),
      eq(workspaceTaskAttachments.ownerType, 'comment'),
      eq(workspaceTaskAttachments.ownerId, commentId),
    ));

  for (const attachment of attachments) {
    try {
      await attachmentStorage.deleteStoredObject({
        storageProvider: attachment.storageProvider,
        storageKey: attachment.storageKey,
      });
    } catch (error) {
      console.warn(`[WorkspaceTaskService] Failed to delete stored object for comment ${commentId} attachment ${attachment.id}:`, error);
    }
  }

  return 'deleted';
}

async function recountTaskUpvotes(taskId: string): Promise<number> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(workspaceTaskVotes)
    .where(and(
      eq(workspaceTaskVotes.taskId, taskId),
      eq(workspaceTaskVotes.value, true),
    ));

  const upvoteCount = Number(row?.count ?? 0);
  await db
    .update(workspaceTasks)
    .set({
      upvoteCount,
      updatedAt: new Date(),
    })
    .where(eq(workspaceTasks.id, taskId));
  return upvoteCount;
}

export async function setTaskUpvote(
  serverId: string,
  taskId: string,
  input: {
    voterId: string;
    voterType?: 'member' | 'external';
    value: boolean;
  },
): Promise<CanonicalTask | null> {
  const voterType = input.voterType ?? 'member';
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
    .limit(1);

  if (!task) return null;

  const [existingVote] = await db
    .select()
    .from(workspaceTaskVotes)
    .where(and(
      eq(workspaceTaskVotes.taskId, taskId),
      eq(workspaceTaskVotes.voterId, input.voterId),
      eq(workspaceTaskVotes.voterType, voterType),
    ))
    .limit(1);

  if (input.value) {
    if (!existingVote) {
      await db.insert(workspaceTaskVotes).values({
        serverId,
        taskId,
        voterId: input.voterId,
        voterType,
        value: true,
      });
    } else if (!existingVote.value) {
      await db
        .update(workspaceTaskVotes)
        .set({ value: true })
        .where(eq(workspaceTaskVotes.id, existingVote.id));
    }
  } else if (existingVote) {
    await db.delete(workspaceTaskVotes).where(eq(workspaceTaskVotes.id, existingVote.id));
  }

  await recountTaskUpvotes(taskId);
  return getTaskById(serverId, taskId, {
    includeAttachments: true,
    viewerId: input.voterId,
    viewerType: voterType,
  });
}

export async function listActivity(taskId: string): Promise<CanonicalTaskActivityEntry[]> {
  const rows = await db
    .select()
    .from(workspaceTaskActivity)
    .where(eq(workspaceTaskActivity.taskId, taskId))
    .orderBy(workspaceTaskActivity.createdAt);
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  const group = attachmentGroups.get(taskId);
  return rows.map((row) => toCanonicalActivity(row, group?.byOwnerId.get(row.id) ?? null));
}

export async function addActivity(
  serverId: string,
  taskId: string,
  input: {
    type: ActivityType;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
    attachments?: CanonicalTaskAttachmentInput[] | null;
  },
): Promise<CanonicalTaskActivityEntry> {
  const [row] = await db
    .insert(workspaceTaskActivity)
    .values({
      serverId,
      taskId,
      type: input.type,
      content: input.content ?? null,
      metadata: input.metadata ?? null,
      createdByType: input.createdByType ?? 'member',
      createdById: input.createdById ?? null,
      createdByName: input.createdByName ?? null,
    })
    .returning();
  if (input.attachments?.length) {
    await insertOwnerAttachments(serverId, taskId, 'activity', row.id, input.attachments);
  }
  const attachmentGroups = await loadTaskAttachmentGroups([taskId]);
  // Activity rows (status_change, agent_assigned, pr_linked, comments) move the
  // partner-facing milestone stepper — push to live SSE subscribers. Best-effort.
  try { publishTicketUpdate(taskId); } catch (err) {
    console.warn('[WorkspaceTaskService] publishTicketUpdate failed', err);
  }
  // Also mirror progress-bearing activity (status change / milestone / PR) into
  // the ticket's live-session chat thread so the session shows the same timeline
  // as the public screen. Best-effort; the dynamic import avoids a module cycle
  // (WidgetChatService → WidgetService → WorkspaceTaskService).
  try {
    const { mirrorActivityToLiveSession } = await import('./WidgetChatService');
    await mirrorActivityToLiveSession(taskId, { id: row.id, type: row.type, content: row.content, metadata: row.metadata });
  } catch (err) {
    console.warn('[WorkspaceTaskService] live-session activity mirror failed', err);
  }
  return toCanonicalActivity(row, attachmentGroups.get(taskId)?.byOwnerId.get(row.id) ?? null);
}

/**
 * Replace the metadata of an existing activity row.
 * The caller is responsible for merging/building the full metadata object;
 * this function performs a straightforward SET replacement.
 */
export async function updateActivityMetadata(
  activityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(workspaceTaskActivity)
    .set({ metadata })
    .where(eq(workspaceTaskActivity.id, activityId));
}

export async function updateAttachmentStorage(
  serverId: string,
  attachmentId: string,
  input: {
    storageProvider: 'workspace-local' | 'r2' | 's3';
    storageKey: string;
    mimeType: string;
    originalName?: string | null;
  },
): Promise<CanonicalTaskAttachment | null> {
  const [row] = await db
    .update(workspaceTaskAttachments)
    .set({
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      originalName: input.originalName ?? null,
    })
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.id, attachmentId),
    ))
    .returning();

  if (!row) return null;
  return toCanonicalAttachment(row);
}

export async function demoteAttachmentToWorkspaceLocal(
  serverId: string,
  attachmentId: string,
  input: {
    filename: string;
    mimeType: string;
    originalName?: string | null;
  },
): Promise<CanonicalTaskAttachment | null> {
  const [existing] = await db
    .select()
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.id, attachmentId),
    ))
    .limit(1);

  if (!existing) return null;

  const previousStorageProvider = existing.storageProvider;
  const previousStorageKey = existing.storageKey;
  const nextStorageKey = `todo/uploads/${input.filename}`;

  const [row] = await db
    .update(workspaceTaskAttachments)
    .set({
      storageProvider: 'workspace-local',
      storageKey: nextStorageKey,
      mimeType: input.mimeType,
      originalName: input.originalName ?? null,
    })
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.id, attachmentId),
    ))
    .returning();

  if (!row) return null;

  try {
    await attachmentStorage.deleteStoredObject({
      storageProvider: previousStorageProvider,
      storageKey: previousStorageKey,
    });
  } catch (error) {
    await db
      .update(workspaceTaskAttachments)
      .set({
        storageProvider: previousStorageProvider,
        storageKey: previousStorageKey,
        mimeType: existing.mimeType,
        originalName: existing.originalName,
      })
      .where(and(
        eq(workspaceTaskAttachments.serverId, serverId),
        eq(workspaceTaskAttachments.id, attachmentId),
      ));
    throw error;
  }

  return toCanonicalAttachment(row);
}

async function replaceTaskAttachments(
  serverId: string,
  taskId: string,
  attachments: CanonicalTaskAttachmentInput[],
): Promise<void> {
  await db
    .delete(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.serverId, serverId),
      eq(workspaceTaskAttachments.taskId, taskId),
      eq(workspaceTaskAttachments.ownerType, 'task'),
    ));

  if (!attachments.length) return;
  await insertOwnerAttachments(serverId, taskId, 'task', taskId, attachments);
}

async function insertOwnerAttachments(
  serverId: string,
  taskId: string,
  ownerType: 'task' | 'comment' | 'activity',
  ownerId: string,
  attachments: CanonicalTaskAttachmentInput[],
): Promise<void> {
  if (!attachments.length) return;
  await db.insert(workspaceTaskAttachments).values(
    attachments.map((attachment) => ({
      serverId,
      taskId,
      ownerType,
      ownerId,
      storageProvider: attachment.storageProvider,
      storageKey: attachment.storageKey,
      mimeType: attachment.mimeType,
      originalName: attachment.originalName ?? null,
      legacyWorkspaceAttachmentKey: attachment.legacyWorkspaceAttachmentKey ?? null,
    })),
  );
}

export async function upsertMigratedTaskBundle(
  serverId: string,
  bundle: CanonicalTaskMigrationBundle,
): Promise<CanonicalTaskMigrationResult> {
  const [existingTask] = await db
    .select({ id: workspaceTasks.id })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.serverId, serverId),
      eq(workspaceTasks.legacyWorkspaceTodoId, bundle.legacyWorkspaceTodoId),
    ))
    .limit(1);

  const [taskRow] = await db
    .insert(workspaceTasks)
    .values({
      serverId,
      workspaceProjectId: bundle.workspaceProjectId ?? null,
      workspaceChannelId: bundle.workspaceChannelId ?? null,
      title: bundle.title,
      description: bundle.description ?? null,
      status: bundle.status,
      visibility: bundle.visibility,
      sourceType: bundle.sourceType,
      createdByType: bundle.createdByType,
      createdById: bundle.createdById ?? null,
      createdByName: bundle.createdByName ?? null,
      commentsDisabled: bundle.commentsDisabled,
      taskType: bundle.type,
      schedule: bundle.schedule ?? null,
      scheduledAt: bundle.scheduledAt ?? null,
      timezone: bundle.timezone ?? null,
      completedAt: fromEpochMs(bundle.completedAt),
      archivedAt: fromEpochMs(bundle.archivedAt),
      deletedAt: fromEpochMs(bundle.deletedAt),
      upvoteCount: bundle.upvoteCount,
      legacyWorkspaceTodoId: bundle.legacyWorkspaceTodoId,
      lastMigratedAt: new Date(),
      createdAt: new Date(bundle.createdAt),
      updatedAt: new Date(bundle.updatedAt),
    })
    .onConflictDoUpdate({
      target: [workspaceTasks.serverId, workspaceTasks.legacyWorkspaceTodoId],
      set: {
        workspaceProjectId: bundle.workspaceProjectId ?? null,
        workspaceChannelId: bundle.workspaceChannelId ?? null,
        title: bundle.title,
        description: bundle.description ?? null,
        status: bundle.status,
        visibility: bundle.visibility,
        sourceType: bundle.sourceType,
        createdByType: bundle.createdByType,
        createdById: bundle.createdById ?? null,
        createdByName: bundle.createdByName ?? null,
        commentsDisabled: bundle.commentsDisabled,
        taskType: bundle.type,
        schedule: bundle.schedule ?? null,
        scheduledAt: bundle.scheduledAt ?? null,
        timezone: bundle.timezone ?? null,
        completedAt: fromEpochMs(bundle.completedAt),
        archivedAt: fromEpochMs(bundle.archivedAt),
        deletedAt: fromEpochMs(bundle.deletedAt),
        upvoteCount: bundle.upvoteCount,
        lastMigratedAt: new Date(),
        updatedAt: new Date(bundle.updatedAt),
      },
    })
    .returning();

  const commentIds = new Map<string, string>();
  const activityIds = new Map<string, string>();

  for (const comment of bundle.comments ?? []) {
    const [row] = await db
      .insert(workspaceTaskComments)
      .values({
        serverId,
        taskId: taskRow.id,
        content: comment.content,
        createdByType: comment.createdByType,
        createdById: comment.createdById ?? null,
        createdByName: comment.createdByName ?? null,
        legacyWorkspaceCommentId: comment.legacyWorkspaceCommentId,
        createdAt: new Date(comment.createdAt),
        updatedAt: new Date(comment.updatedAt ?? comment.createdAt),
        deletedAt: fromEpochMs(comment.deletedAt),
      })
      .onConflictDoUpdate({
        target: [workspaceTaskComments.serverId, workspaceTaskComments.legacyWorkspaceCommentId],
        set: {
          taskId: taskRow.id,
          content: comment.content,
          createdByType: comment.createdByType,
          createdById: comment.createdById ?? null,
          createdByName: comment.createdByName ?? null,
          updatedAt: new Date(comment.updatedAt ?? comment.createdAt),
          deletedAt: fromEpochMs(comment.deletedAt),
        },
      })
      .returning();
    commentIds.set(comment.legacyWorkspaceCommentId, row.id);
  }

  for (const activity of bundle.activity ?? []) {
    const [row] = await db
      .insert(workspaceTaskActivity)
      .values({
        serverId,
        taskId: taskRow.id,
        type: activity.type,
        content: activity.content ?? null,
        metadata: activity.metadata ?? null,
        createdByType: activity.createdByType,
        createdById: activity.createdById ?? null,
        createdByName: activity.createdByName ?? null,
        legacyWorkspaceActivityId: activity.legacyWorkspaceActivityId,
        createdAt: new Date(activity.createdAt),
      })
      .onConflictDoUpdate({
        target: [workspaceTaskActivity.serverId, workspaceTaskActivity.legacyWorkspaceActivityId],
        set: {
          taskId: taskRow.id,
          type: activity.type,
          content: activity.content ?? null,
          metadata: activity.metadata ?? null,
          createdByType: activity.createdByType,
          createdById: activity.createdById ?? null,
          createdByName: activity.createdByName ?? null,
        },
      })
      .returning();
    activityIds.set(activity.legacyWorkspaceActivityId, row.id);
  }

  const allAttachments = [
    ...(bundle.attachments ?? []),
    ...((bundle.comments ?? []).flatMap((comment: NonNullable<CanonicalTaskMigrationBundle['comments']>[number]) => comment.attachments ?? [])),
    ...((bundle.activity ?? []).flatMap((activity: NonNullable<CanonicalTaskMigrationBundle['activity']>[number]) => activity.attachments ?? [])),
  ];

  for (const attachment of allAttachments) {
    let ownerId = taskRow.id;
    if (attachment.ownerType === 'comment') {
      ownerId = commentIds.get(attachment.ownerLegacyId) ?? ownerId;
    } else if (attachment.ownerType === 'activity') {
      ownerId = activityIds.get(attachment.ownerLegacyId) ?? ownerId;
    }

    await db
      .insert(workspaceTaskAttachments)
      .values({
        serverId,
        taskId: taskRow.id,
        ownerType: attachment.ownerType,
        ownerId,
        storageProvider: attachment.storageProvider,
        storageKey: attachment.storageKey,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName ?? null,
        legacyWorkspaceAttachmentKey: attachment.legacyWorkspaceAttachmentKey,
      })
      .onConflictDoUpdate({
        target: [workspaceTaskAttachments.serverId, workspaceTaskAttachments.legacyWorkspaceAttachmentKey],
        set: {
          taskId: taskRow.id,
          ownerType: attachment.ownerType,
          ownerId,
          storageProvider: attachment.storageProvider,
          storageKey: attachment.storageKey,
          mimeType: attachment.mimeType,
          originalName: attachment.originalName ?? null,
        },
      });
  }

  return {
    legacyWorkspaceTodoId: bundle.legacyWorkspaceTodoId,
    canonicalTaskId: taskRow.id,
    created: !existingTask,
    commentsUpserted: bundle.comments?.length ?? 0,
    activityUpserted: bundle.activity?.length ?? 0,
    attachmentsUpserted: allAttachments.length,
  };
}

export async function getMigrationSummary(serverId: string): Promise<CanonicalTaskMigrationSummary> {
  const [taskCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTasks)
    .where(and(eq(workspaceTasks.serverId, serverId), sql`${workspaceTasks.legacyWorkspaceTodoId} IS NOT NULL`));
  const [commentCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskComments)
    .where(and(eq(workspaceTaskComments.serverId, serverId), sql`${workspaceTaskComments.legacyWorkspaceCommentId} IS NOT NULL`));
  const [activityCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskActivity)
    .where(and(eq(workspaceTaskActivity.serverId, serverId), sql`${workspaceTaskActivity.legacyWorkspaceActivityId} IS NOT NULL`));
  const [attachmentCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskAttachments)
    .where(and(eq(workspaceTaskAttachments.serverId, serverId), sql`${workspaceTaskAttachments.legacyWorkspaceAttachmentKey} IS NOT NULL`));
  const [latestTask] = await db
    .select({ updatedAt: workspaceTasks.updatedAt })
    .from(workspaceTasks)
    .where(and(eq(workspaceTasks.serverId, serverId), sql`${workspaceTasks.legacyWorkspaceTodoId} IS NOT NULL`))
    .orderBy(desc(workspaceTasks.updatedAt))
    .limit(1);

  return {
    serverId,
    tasks: Number(taskCount?.count ?? 0),
    comments: Number(commentCount?.count ?? 0),
    activity: Number(activityCount?.count ?? 0),
    attachments: Number(attachmentCount?.count ?? 0),
    lastTaskUpdatedAt: latestTask?.updatedAt?.toISOString() ?? null,
  };
}
