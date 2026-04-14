import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  workspaceTasks,
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  type WorkspaceTask,
} from '../../db/schema';
import type {
  ActivityType,
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
  type?: CanonicalTaskType;
  schedule?: string | null;
  scheduledAt?: number | null;
  timezone?: string | null;
  completedAt?: string | Date | null;
  archivedAt?: string | Date | null;
  deletedAt?: string | Date | null;
  upvoteCount?: number;
  legacyWorkspaceTodoId?: string | null;
};

type UpdateWorkspaceTaskInput = Partial<CreateWorkspaceTaskInput>;

function toIso(value?: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function fromEpochMs(value?: number | null): Date | null {
  if (value === undefined || value === null) return null;
  return new Date(value);
}

function toCanonicalTask(row: WorkspaceTask): CanonicalTask {
  return {
    id: row.id,
    serverId: row.serverId,
    workspaceProjectId: row.workspaceProjectId,
    workspaceChannelId: row.workspaceChannelId,
    title: row.title,
    description: row.description,
    status: row.status as CanonicalTaskStatus,
    visibility: row.visibility as CanonicalTaskVisibility,
    sourceType: row.sourceType as CanonicalTaskSourceType,
    createdByType: row.createdByType as CanonicalTask['createdByType'],
    createdById: row.createdById,
    createdByName: row.createdByName,
    commentsDisabled: row.commentsDisabled,
    type: row.taskType as CanonicalTaskType,
    schedule: row.schedule,
    scheduledAt: row.scheduledAt ?? null,
    timezone: row.timezone,
    completedAt: toIso(row.completedAt),
    archivedAt: toIso(row.archivedAt),
    deletedAt: toIso(row.deletedAt),
    legacyWorkspaceTodoId: row.legacyWorkspaceTodoId,
    upvoteCount: row.upvoteCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCanonicalComment(row: typeof workspaceTaskComments.$inferSelect): CanonicalTaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    content: row.content,
    createdByType: row.createdByType as CanonicalTaskComment['createdByType'],
    createdById: row.createdById,
    createdByName: row.createdByName,
    legacyWorkspaceCommentId: row.legacyWorkspaceCommentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: toIso(row.deletedAt),
  };
}

function toCanonicalActivity(row: typeof workspaceTaskActivity.$inferSelect): CanonicalTaskActivityEntry {
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
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTasksByServer(
  serverId: string,
  options?: { visibility?: CanonicalTaskVisibility; includeDeleted?: boolean },
): Promise<CanonicalTask[]> {
  const conditions = [eq(workspaceTasks.serverId, serverId)];
  if (options?.visibility) conditions.push(eq(workspaceTasks.visibility, options.visibility));
  if (!options?.includeDeleted) conditions.push(isNull(workspaceTasks.deletedAt));
  const rows = await db
    .select()
    .from(workspaceTasks)
    .where(and(...conditions))
    .orderBy(desc(workspaceTasks.updatedAt));
  return rows.map(toCanonicalTask);
}

export async function getTaskById(serverId: string, taskId: string): Promise<CanonicalTask | null> {
  const [row] = await db
    .select()
    .from(workspaceTasks)
    .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
    .limit(1);
  return row ? toCanonicalTask(row) : null;
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
      sourceType: input.sourceType ?? 'workspace',
      createdByType: input.createdByType ?? 'member',
      createdById: input.createdById ?? null,
      createdByName: input.createdByName ?? null,
      commentsDisabled: input.commentsDisabled ?? false,
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
  return toCanonicalTask(row);
}

export async function updateTask(
  serverId: string,
  taskId: string,
  input: UpdateWorkspaceTaskInput,
): Promise<CanonicalTask | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.workspaceProjectId !== undefined) updates.workspaceProjectId = input.workspaceProjectId;
  if (input.workspaceChannelId !== undefined) updates.workspaceChannelId = input.workspaceChannelId;
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;
  if (input.visibility !== undefined) updates.visibility = input.visibility;
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

  const [row] = await db
    .update(workspaceTasks)
    .set(updates)
    .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
    .returning();
  return row ? toCanonicalTask(row) : null;
}

export async function listComments(taskId: string): Promise<CanonicalTaskComment[]> {
  const rows = await db
    .select()
    .from(workspaceTaskComments)
    .where(eq(workspaceTaskComments.taskId, taskId))
    .orderBy(workspaceTaskComments.createdAt);
  return rows.map(toCanonicalComment);
}

export async function addComment(
  serverId: string,
  taskId: string,
  input: {
    content: string;
    createdByType?: 'member' | 'external' | 'system' | 'agent';
    createdById?: string | null;
    createdByName?: string | null;
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
  return toCanonicalComment(row);
}

export async function listActivity(taskId: string): Promise<CanonicalTaskActivityEntry[]> {
  const rows = await db
    .select()
    .from(workspaceTaskActivity)
    .where(eq(workspaceTaskActivity.taskId, taskId))
    .orderBy(workspaceTaskActivity.createdAt);
  return rows.map(toCanonicalActivity);
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
  return toCanonicalActivity(row);
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
