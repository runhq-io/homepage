import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  workspaceTasks,
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  workspaceTaskVotes,
  type WorkspaceTask,
} from '../../db/schema';
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
  moderationStatus?: 'pending' | 'approved' | 'rejected';
  legacyWorkspaceTodoId?: string | null;
  attachments?: CanonicalTaskAttachmentInput[] | null;
};

type UpdateWorkspaceTaskInput = Partial<CreateWorkspaceTaskInput>;

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
    downvoteCount: row.downvoteCount,
    moderationStatus: row.moderationStatus as 'pending' | 'approved' | 'rejected',
    votingEndsAt: toIso(row.votingEndsAt),
    upvotedByMe: false,
    attachments: attachments ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

export async function getTaskById(
  serverId: string,
  taskId: string,
  options?: {
    includeAttachments?: boolean;
    viewerId?: string | null;
    viewerType?: 'member' | 'external';
  },
): Promise<CanonicalTask | null> {
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
  if (input.attachments?.length) {
    await replaceTaskAttachments(serverId, row.id, input.attachments);
  }
  const attachmentGroups = input.attachments?.length ? await loadTaskAttachmentGroups([row.id]) : null;
  return toCanonicalTask(row, attachmentGroups?.get(row.id)?.task ?? null);
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
  if (input.moderationStatus !== undefined) updates.moderationStatus = input.moderationStatus;

  const [row] = await db
    .update(workspaceTasks)
    .set(updates)
    .where(and(eq(workspaceTasks.serverId, serverId), eq(workspaceTasks.id, taskId)))
    .returning();
  if (!row) return null;
  if (input.attachments !== undefined) {
    await replaceTaskAttachments(serverId, row.id, input.attachments ?? []);
  }
  const attachmentGroups = await loadTaskAttachmentGroups([row.id]);
  return toCanonicalTask(row, attachmentGroups.get(row.id)?.task ?? null);
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

export async function deleteComment(
  serverId: string,
  taskId: string,
  commentId: string,
): Promise<boolean> {
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

  if (!comment) return false;

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

  return true;
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
  return toCanonicalActivity(row, attachmentGroups.get(taskId)?.byOwnerId.get(row.id) ?? null);
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
