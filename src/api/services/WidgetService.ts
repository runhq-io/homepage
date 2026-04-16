/**
 * WidgetService
 *
 * Handles widget authentication (3 modes), ticket CRUD, voting,
 * project management, and AI title generation.
 *
 * All ticket data lives in the unified `workspace_tasks` table.
 * Widget submissions use sourceType='widget' and createdByType='external'.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import { db } from '../../db/index';
import {
  widgetProjects,
  widgetUsers,
  workspaceTasks,
  workspaceTaskVotes,
  workspaceTaskComments,
  workspaceTaskActivity,
  workspaceTaskAttachments,
  servers,
} from '../../db/schema';
import { eq, and, ne, desc, sql, inArray, isNull, or } from 'drizzle-orm';
import * as WorkspaceTaskService from './WorkspaceTaskService';
import { TaskAttachmentStorageService } from './TaskAttachmentStorageService';

const attachmentStorage = new TaskAttachmentStorageService();

// ============================================================================
// Types
// ============================================================================

export interface WidgetAuthResult {
  projectId: string;
  projectSlug: string;
  widgetUserId?: string;
  /** True when the request was authenticated via a signed JWT (customer's server vouched for it) */
  authenticated: boolean;
}

interface HonoRequest {
  header(name: string): string | undefined;
}

interface WidgetProjectContext {
  id: string;
  name: string;
  slug: string;
  widgetPosition: string | null;
  serverId: string;
  channelId: string | null;
}

type WidgetTicketResponse = {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';
  moderationStatus: 'pending' | 'approved' | 'rejected';
  isPrivate: boolean;
  source: string;
  widgetUserId: string | null;
  authorName: string | null;
  yesVotes: number;
  noVotes: number;
  votingEndsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  userVote: boolean | null;
  canVote: boolean;
};

type PublicAttachmentSummary = {
  id?: string;
  filename?: string;
  originalName?: string | null;
  mimeType?: string;
  url?: string | null;
};

export type PublicTicketDetail = {
  ticket: WidgetTicketResponse & {
    attachments?: PublicAttachmentSummary[] | null;
  };
  /** Whether the requesting user owns this ticket */
  isOwner: boolean;
  /** Whether the ticket can be edited/deleted by its owner right now */
  isEditable: boolean;
  comments: Array<{
    id: string;
    body: string;
    authorName: string | null;
    createdAt: string;
    updatedAt?: string | null;
    attachments?: PublicAttachmentSummary[] | null;
  }>;
  activity: Array<{
    id: string;
    type: string;
    content?: string | null;
    createdByName?: string | null;
    createdAt: string;
    metadata?: Record<string, unknown> | null;
    attachments?: PublicAttachmentSummary[] | null;
  }>;
};

type PublicAttachmentLike = {
  id?: string;
  storageKey: string;
  originalName?: string | null;
  mimeType: string;
  url?: string | null;
};

function mapAttachmentSummary(attachment: PublicAttachmentLike): PublicAttachmentSummary {
  return {
    id: attachment.id,
    filename: attachment.storageKey.split('/').pop(),
    originalName: attachment.originalName ?? null,
    mimeType: attachment.mimeType,
    url: attachment.url ?? null,
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function getWidgetProjectContext(projectId: string): Promise<WidgetProjectContext | null> {
  const [project] = await db
    .select({
      id: widgetProjects.id,
      name: widgetProjects.name,
      slug: widgetProjects.slug,
      widgetPosition: widgetProjects.widgetPosition,
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  return project ?? null;
}

function getHomepageUrl(): string {
  const cloudApiUrl = process.env.CLOUD_API_URL || 'https://console.runhq.io';
  return cloudApiUrl
    .replace('console-staging.', 'staging.')
    .replace('console.', 'www.');
}

/**
 * Build a filter for tasks visible in the widget for a given project.
 * Includes both widget-submitted and workspace-created public tasks.
 */
function buildWidgetVisibleFilter(project: WidgetProjectContext) {
  const baseConditions = [
    eq(workspaceTasks.serverId, project.serverId),
    isNull(workspaceTasks.deletedAt),
    eq(workspaceTasks.moderationStatus, 'approved'),
  ];

  if (project.channelId) {
    // Scoped to channel: widget tasks in this channel + public workspace tasks in this channel
    return and(
      ...baseConditions,
      eq(workspaceTasks.workspaceChannelId, project.channelId),
      or(
        eq(workspaceTasks.sourceType, 'widget'),
        and(eq(workspaceTasks.sourceType, 'workspace'), eq(workspaceTasks.visibility, 'public')),
      ),
    );
  }

  // No channel scope: all widget tasks + public workspace tasks for this server
  return and(
    ...baseConditions,
    or(
      eq(workspaceTasks.sourceType, 'widget'),
      and(eq(workspaceTasks.sourceType, 'workspace'), eq(workspaceTasks.visibility, 'public')),
    ),
  );
}

function mapTaskToWidgetResponse(
  task: typeof workspaceTasks.$inferSelect,
  userVote: boolean | null = null,
  canVote: boolean = true,
): WidgetTicketResponse {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    moderationStatus: task.moderationStatus,
    isPrivate: task.visibility === 'private',
    source: task.sourceType,
    widgetUserId: task.createdByType === 'external' ? task.createdById : null,
    authorName: task.createdByName ?? null,
    yesVotes: task.upvoteCount,
    noVotes: task.downvoteCount,
    votingEndsAt: task.votingEndsAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    userVote,
    canVote,
  };
}

/** Decode a standard JWT payload without verifying signature (for extracting `fp` before lookup). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return payload;
  } catch {
    return null;
  }
}

async function recountVotes(taskId: string, serverId: string): Promise<void> {
  const votes = await db
    .select({ value: workspaceTaskVotes.value })
    .from(workspaceTaskVotes)
    .where(eq(workspaceTaskVotes.taskId, taskId));

  const upvoteCount = votes.filter((v) => v.value === true).length;
  const downvoteCount = votes.filter((v) => v.value === false).length;

  await db
    .update(workspaceTasks)
    .set({ upvoteCount, downvoteCount, updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId));
}

// ============================================================================
// Auth
// ============================================================================

/**
 * Authenticates a widget request using one of three modes:
 * 1. Public slug mode — no Authorization, X-RW-Project: {slug}
 * 2. Raw API key mode — Authorization: Bearer rw_xxx (no dot)
 * 3. Signed JWT mode — Authorization: Bearer {payload}.{signature}
 */
export async function authenticateWidget(
  req: HonoRequest
): Promise<WidgetAuthResult | null> {
  const authHeader = req.header('Authorization');
  const projectSlugHeader = req.header('X-RW-Project');

  // ---- Mode 1: Public slug (no auth header) ----
  if (!authHeader && projectSlugHeader) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled, isPublic: widgetProjects.isPublic })
      .from(widgetProjects)
      .where(eq(widgetProjects.slug, projectSlugHeader))
      .limit(1);

    if (!project || !project.enabled || !project.isPublic) return null;
    return { projectId: project.id, projectSlug: project.slug, authenticated: false };
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7); // remove "Bearer "
  const dotIndex = token.indexOf('.');

  // ---- Mode 2: Raw API key (no dot in token) ----
  if (dotIndex === -1) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled })
      .from(widgetProjects)
      .where(eq(widgetProjects.apiKey, token))
      .limit(1);

    if (!project || !project.enabled) return null;
    return { projectId: project.id, projectSlug: project.slug, authenticated: false };
  }

  // ---- Mode 3: Signed JWT (standard 3-part header.payload.signature) ----
  // Decode unverified payload to extract `fp` for project lookup
  const decoded = decodeJwtPayload(token);
  if (!decoded || typeof decoded.fp !== 'string') return null;

  const [project] = await db
    .select({
      id: widgetProjects.id,
      slug: widgetProjects.slug,
      enabled: widgetProjects.enabled,
      apiSecretHash: widgetProjects.apiSecretHash,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.apiKey, decoded.fp))
    .limit(1);

  if (!project || !project.enabled) return null;

  // Verify signature, expiry, and type using jose
  let payload: jose.JWTPayload;
  try {
    const secret = new TextEncoder().encode(project.apiSecretHash);
    const { payload: verified } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });
    if (verified.type !== 'widget_user') return null;
    payload = verified;
  } catch {
    return null;
  }

  // If sub is provided, upsert a widgetUser for identified submissions
  let widgetUserId: string | undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  if (sub) {
    const [existing] = await db
      .select({ id: widgetUsers.id })
      .from(widgetUsers)
      .where(
        and(
          eq(widgetUsers.projectId, project.id),
          eq(widgetUsers.externalUserId, sub)
        )
      )
      .limit(1);

    if (existing) {
      if (name) {
        await db
          .update(widgetUsers)
          .set({ name })
          .where(eq(widgetUsers.id, existing.id));
      }
      widgetUserId = existing.id;
    } else {
      const [inserted] = await db
        .insert(widgetUsers)
        .values({
          projectId: project.id,
          externalUserId: sub,
          name,
        })
        .returning({ id: widgetUsers.id });
      widgetUserId = inserted.id;
    }
  }

  return { projectId: project.id, projectSlug: project.slug, widgetUserId, authenticated: true };
}

// ============================================================================
// Ticket Operations
// ============================================================================

export async function listTickets(projectId: string, widgetUserId?: string) {
  const project = await getWidgetProjectContext(projectId);

  const rows = project
    ? await db
        .select()
        .from(workspaceTasks)
        .where(and(
          buildWidgetVisibleFilter(project),
          eq(workspaceTasks.visibility, 'public'),
        ))
        .orderBy(desc(workspaceTasks.createdAt))
        .limit(50)
    : [];

  // Fetch votes for identified user
  let userVoteMap: Map<string, boolean> = new Map();
  if (widgetUserId && rows.length > 0) {
    const taskIds = rows.map((t) => t.id);
    const votes = await db
      .select({ taskId: workspaceTaskVotes.taskId, value: workspaceTaskVotes.value })
      .from(workspaceTaskVotes)
      .where(
        and(
          inArray(workspaceTaskVotes.taskId, taskIds),
          eq(workspaceTaskVotes.voterId, widgetUserId),
        )
      );
    for (const v of votes) {
      userVoteMap.set(v.taskId, v.value);
    }
  }

  const tickets: WidgetTicketResponse[] = rows.map((t) =>
    mapTaskToWidgetResponse(t, userVoteMap.get(t.id) ?? null, true)
  );

  return {
    projectName: project?.name ?? '',
    projectSlug: project?.slug ?? '',
    homepageUrl: getHomepageUrl(),
    position: project?.widgetPosition ?? null,
    isIdentified: !!widgetUserId,
    tickets,
  };
}

export async function getPublicTicketDetail(projectId: string, ticketId: string, widgetUserId?: string): Promise<PublicTicketDetail | null> {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return null;

  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
      ne(workspaceTasks.moderationStatus, 'rejected'),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) return null;

  const isCreator = !!widgetUserId && task.createdByType === 'external' && task.createdById === widgetUserId;

  // Pending moderation tickets are only visible to their creator
  if (task.moderationStatus === 'pending' && !isCreator) return null;

  // Private tasks are only visible to their creator
  if (task.visibility === 'private' && !isCreator) return null;

  // Get comments
  const comments = await WorkspaceTaskService.listComments(task.id);
  // Get activity
  const activity = await WorkspaceTaskService.listActivity(task.id);
  // Get attachments
  const fullTask = await WorkspaceTaskService.getTaskById(project.serverId, task.id, { includeAttachments: true });

  const isOwner = isCreator;
  const isEditable = isOwner
    && task.status === 'pending'
    && task.moderationStatus !== 'rejected'
    && comments.length === 0
    && activity.length === 0;

  return {
    ticket: {
      ...mapTaskToWidgetResponse(task),
      attachments: (fullTask?.attachments ?? []).map(mapAttachmentSummary),
    },
    isOwner,
    isEditable,
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.content,
      authorName: comment.createdByName ?? null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      attachments: (comment.attachments ?? []).map(mapAttachmentSummary),
    })),
    activity: activity.map((entry) => ({
      id: entry.id,
      type: entry.type,
      content: entry.content ?? null,
      createdByName: entry.createdByName ?? null,
      createdAt: entry.createdAt,
      metadata: entry.metadata ?? null,
      attachments: (entry.attachments ?? []).map(mapAttachmentSummary),
    })),
  };
}

const ALLOWED_METADATA_KEYS = new Set([
  'url', 'referrer', 'userAgent', 'viewport', 'screenSize',
  'locale', 'timestamp', 'consoleLogs', 'errors',
]);
const MAX_STRING_LENGTH = 2048;
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_MESSAGE_LENGTH = 1024;

function sanitizeWidgetMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const input = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const val = input[key];

    if (key === 'url' || key === 'referrer' || key === 'userAgent' || key === 'locale' || key === 'timestamp') {
      if (typeof val === 'string') result[key] = val.slice(0, MAX_STRING_LENGTH);
    } else if (key === 'viewport' || key === 'screenSize') {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        if (typeof obj.width === 'number' && typeof obj.height === 'number') {
          result[key] = { width: obj.width, height: obj.height };
        }
      }
    } else if (key === 'consoleLogs') {
      if (Array.isArray(val)) {
        result[key] = val.slice(0, MAX_LOG_ENTRIES).map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          return {
            level: typeof e.level === 'string' ? e.level.slice(0, 10) : 'log',
            message: typeof e.message === 'string' ? e.message.slice(0, MAX_LOG_MESSAGE_LENGTH) : '',
            ts: typeof e.ts === 'string' ? e.ts.slice(0, 30) : '',
          };
        }).filter(Boolean);
      }
    } else if (key === 'errors') {
      if (Array.isArray(val)) {
        result[key] = val.slice(0, MAX_LOG_ENTRIES).map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          return {
            type: typeof e.type === 'string' ? e.type.slice(0, 50) : 'error',
            message: typeof e.message === 'string' ? e.message.slice(0, MAX_LOG_MESSAGE_LENGTH) : '',
            source: typeof e.source === 'string' ? e.source.slice(0, MAX_STRING_LENGTH) : undefined,
            line: typeof e.line === 'number' ? e.line : undefined,
            col: typeof e.col === 'number' ? e.col : undefined,
            stack: typeof e.stack === 'string' ? e.stack.slice(0, MAX_STRING_LENGTH) : undefined,
            ts: typeof e.ts === 'string' ? e.ts.slice(0, 30) : '',
          };
        }).filter(Boolean);
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export async function createTicket(
  projectId: string,
  widgetUserId: string | undefined,
  opts: { title?: string; description?: string; isPrivate?: boolean; context?: unknown }
) {
  const [project] = await db
    .select({
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      autoApprove: widgetProjects.autoApprove,
      votingPeriodHours: widgetProjects.votingPeriodHours,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  if (!project) throw new Error('Project not found');

  let title = opts.title?.trim() || '';
  if (!title && opts.description) {
    title = await generateTitle(opts.description);
  }
  if (!title) title = 'Untitled';

  const moderationStatus = project.autoApprove ? 'approved' : 'pending';

  let votingEndsAt: Date | undefined;
  if (project.votingPeriodHours && project.votingPeriodHours > 0) {
    votingEndsAt = new Date(
      Date.now() + project.votingPeriodHours * 60 * 60 * 1000
    );
  }

  // Resolve widget user name
  let createdByName: string | undefined;
  if (widgetUserId) {
    const [wu] = await db
      .select({ name: widgetUsers.name })
      .from(widgetUsers)
      .where(eq(widgetUsers.id, widgetUserId))
      .limit(1);
    createdByName = wu?.name || undefined;
  }

  const metadata = sanitizeWidgetMetadata(opts.context);

  const [task] = await db
    .insert(workspaceTasks)
    .values({
      serverId: project.serverId,
      workspaceChannelId: project.channelId,
      title,
      description: opts.description,
      visibility: opts.isPrivate ? 'private' : 'public',
      sourceType: 'widget',
      createdByType: 'external',
      createdById: widgetUserId ?? null,
      createdByName: createdByName ?? null,
      moderationStatus,
      votingEndsAt,
      metadata,
    })
    .returning();

  return task;
}

/**
 * Check if a task can be edited/deleted by a widget user.
 * Returns the task row if editable, or throws with a reason.
 */
async function requireEditableTask(taskId: string, serverId: string, widgetUserId: string) {
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, taskId),
      eq(workspaceTasks.serverId, serverId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new Error('Ticket not found');
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new Error('Not the ticket owner');
  }
  if (task.status !== 'pending') throw new Error('Ticket status is no longer pending');
  if (task.moderationStatus === 'rejected') throw new Error('Ticket has been rejected');

  const [commentCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.taskId, taskId),
      isNull(workspaceTaskComments.deletedAt),
    ));
  if (Number(commentCount.count) > 0) throw new Error('Ticket has comments and cannot be modified');

  const [activityCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskActivity)
    .where(eq(workspaceTaskActivity.taskId, taskId));
  if (Number(activityCount.count) > 0) throw new Error('Ticket has activity and cannot be modified');

  return task;
}

export async function updateTicket(
  ticketId: string,
  projectId: string,
  widgetUserId: string,
  opts: { title?: string; description?: string },
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new Error('Project not found');

  await requireEditableTask(ticketId, project.serverId, widgetUserId);

  const updates: Partial<typeof workspaceTasks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (opts.title !== undefined) updates.title = opts.title.trim() || 'Untitled';
  if (opts.description !== undefined) updates.description = opts.description;

  const [updated] = await db
    .update(workspaceTasks)
    .set(updates)
    .where(eq(workspaceTasks.id, ticketId))
    .returning();

  return updated;
}

export async function deleteTicket(
  ticketId: string,
  projectId: string,
  widgetUserId: string,
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new Error('Project not found');

  await requireEditableTask(ticketId, project.serverId, widgetUserId);

  // Soft delete to be consistent with workspace task patterns
  await db
    .update(workspaceTasks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceTasks.id, ticketId));
}

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ATTACHMENTS_PER_TICKET = 5;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

export async function uploadTicketAttachment(
  ticketId: string,
  projectId: string,
  widgetUserId: string,
  file: { buffer: Buffer; mimeType: string; filename: string; originalName?: string },
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new Error('Project not found');

  if (!attachmentStorage.isConfigured()) {
    throw new Error('Attachment storage is not configured');
  }

  // Validate image type
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimeType)) {
    throw new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)');
  }

  // Validate file size
  if (file.buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new Error('File size exceeds 5MB limit');
  }

  // Verify ownership — task must exist, belong to this user, and be on this server
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new Error('Ticket not found');
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new Error('Not the ticket owner');
  }

  // Check attachment count limit
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.taskId, ticketId),
      eq(workspaceTaskAttachments.ownerType, 'task'),
    ));
  if (Number(countRow.count) >= MAX_ATTACHMENTS_PER_TICKET) {
    throw new Error(`Maximum ${MAX_ATTACHMENTS_PER_TICKET} attachments per ticket`);
  }

  // Upload to R2
  const stored = await attachmentStorage.storeUpload({
    serverId: project.serverId,
    body: file.buffer,
    mimeType: file.mimeType,
    filename: file.filename,
    originalName: file.originalName ?? file.filename,
    ownerType: 'task',
  });

  // Insert attachment record
  const [attachment] = await db
    .insert(workspaceTaskAttachments)
    .values({
      serverId: project.serverId,
      taskId: ticketId,
      ownerType: 'task',
      ownerId: ticketId,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      mimeType: stored.mimeType,
      originalName: stored.originalName ?? null,
    })
    .returning();

  // Generate download URL
  const url = await attachmentStorage.createDownloadUrl({
    storageProvider: stored.storageProvider,
    storageKey: stored.storageKey,
    originalName: stored.originalName,
  });

  return {
    id: attachment.id,
    filename: stored.storageKey.split('/').pop(),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    url,
  };
}

export async function deleteTicketAttachment(
  ticketId: string,
  attachmentId: string,
  projectId: string,
  widgetUserId: string,
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new Error('Project not found');

  // Verify ownership
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new Error('Ticket not found');
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new Error('Not the ticket owner');
  }

  // Find the attachment
  const [attachment] = await db
    .select()
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.id, attachmentId),
      eq(workspaceTaskAttachments.taskId, ticketId),
    ))
    .limit(1);

  if (!attachment) throw new Error('Attachment not found');

  // Delete from object storage
  await attachmentStorage.deleteStoredObject({
    storageProvider: attachment.storageProvider,
    storageKey: attachment.storageKey,
  });

  // Delete DB record
  await db
    .delete(workspaceTaskAttachments)
    .where(eq(workspaceTaskAttachments.id, attachmentId));
}

export async function listMyTickets(
  projectId: string,
  widgetUserId: string
): Promise<WidgetTicketResponse[]> {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return [];

  const rows = await db
    .select()
    .from(workspaceTasks)
    .where(
      and(
        eq(workspaceTasks.serverId, project.serverId),
        eq(workspaceTasks.createdByType, 'external'),
        eq(workspaceTasks.createdById, widgetUserId),
        eq(workspaceTasks.sourceType, 'widget'),
        isNull(workspaceTasks.deletedAt),
      )
    )
    .orderBy(desc(workspaceTasks.createdAt))
    .limit(50);

  return rows.map((t) => mapTaskToWidgetResponse(t));
}

export async function getTicketStats(projectId: string) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return { totalOpen: 0, totalDone: 0, totalResolved: 0, avgResolutionMs: null };

  const channelCondition = project.channelId
    ? eq(workspaceTasks.workspaceChannelId, project.channelId)
    : undefined;

  const conditions = [
    eq(workspaceTasks.serverId, project.serverId),
    eq(workspaceTasks.visibility, 'public'),
    eq(workspaceTasks.moderationStatus, 'approved'),
    isNull(workspaceTasks.deletedAt),
    ...(channelCondition ? [channelCondition] : []),
  ];

  const [result] = await db
    .select({
      totalOpen: sql<number>`count(*) filter (where ${workspaceTasks.status} not in ('done', 'cancelled'))`,
      totalDone: sql<number>`count(*) filter (where ${workspaceTasks.status} = 'done')`,
    })
    .from(workspaceTasks)
    .where(and(...conditions));

  const totalDone = Number(result?.totalDone ?? 0);

  // Calculate average resolution time for done tasks
  let avgResolutionMs: number | null = null;
  if (totalDone > 0) {
    const [avgResult] = await db
      .select({
        avg: sql<number>`avg(extract(epoch from (${workspaceTasks.completedAt} - ${workspaceTasks.createdAt})) * 1000)`,
      })
      .from(workspaceTasks)
      .where(and(
        ...conditions,
        eq(workspaceTasks.status, 'done'),
        sql`${workspaceTasks.completedAt} is not null`,
      ));
    avgResolutionMs = avgResult?.avg ? Math.round(Number(avgResult.avg)) : null;
  }

  return {
    totalOpen: Number(result?.totalOpen ?? 0),
    totalDone,
    totalResolved: totalDone,
    avgResolutionMs,
  };
}

export async function castVote(
  ticketId: string,
  widgetUserId: string,
  value: boolean
) {
  const [task] = await db
    .select({
      id: workspaceTasks.id,
      serverId: workspaceTasks.serverId,
      moderationStatus: workspaceTasks.moderationStatus,
      votingEndsAt: workspaceTasks.votingEndsAt,
    })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new Error('Ticket not found');
  if (task.moderationStatus !== 'approved') {
    throw new Error('Voting is only allowed on approved tickets');
  }
  if (task.votingEndsAt && new Date() > task.votingEndsAt) {
    throw new Error('Voting period has ended');
  }

  await db
    .insert(workspaceTaskVotes)
    .values({
      serverId: task.serverId,
      taskId: ticketId,
      voterType: 'external',
      voterId: widgetUserId,
      value,
    })
    .onConflictDoUpdate({
      target: [workspaceTaskVotes.taskId, workspaceTaskVotes.voterId],
      set: { value },
    });

  await recountVotes(ticketId, task.serverId);
}

export async function retractVote(ticketId: string, widgetUserId: string) {
  const [task] = await db
    .select({ serverId: workspaceTasks.serverId })
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, ticketId))
    .limit(1);

  await db
    .delete(workspaceTaskVotes)
    .where(
      and(
        eq(workspaceTaskVotes.taskId, ticketId),
        eq(workspaceTaskVotes.voterId, widgetUserId),
      )
    );

  if (task) {
    await recountVotes(ticketId, task.serverId);
  }
}

// ============================================================================
// Project Management (for RunHQ UI)
// ============================================================================

/** Derive a fingerprint from the secret for JWT fp field / project lookup. */
function deriveFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32);
}

function generateSlug(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base}-${suffix}`;
}

export async function enableWidget(
  serverId: string,
  opts: { name: string; channelId?: string }
) {
  // Check if a project already exists for this server (re-enable case)
  const [existing] = await db
    .select({ slug: widgetProjects.slug })
    .from(widgetProjects)
    .where(eq(widgetProjects.serverId, serverId))
    .limit(1);

  const apiSecret = randomBytes(32).toString('base64url');
  const apiKey = deriveFingerprint(apiSecret);
  const slugSuffix = randomBytes(4).toString('hex');
  const slug = existing?.slug ?? generateSlug(opts.name, slugSuffix);

  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId,
      name: opts.name,
      slug,
      apiKey,
      apiSecretHash: apiSecret,
      enabled: true,
      channelId: opts.channelId,
    })
    .onConflictDoUpdate({
      target: widgetProjects.slug,
      set: {
        enabled: true,
        name: opts.name,
        apiKey,
        apiSecretHash: apiSecret,
        channelId: opts.channelId,
        updatedAt: new Date(),
      },
    })
    .returning();

  return { ...project, apiSecret };
}

export async function disableWidget(serverId: string) {
  await db
    .update(widgetProjects)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(widgetProjects.serverId, serverId));
}

export async function regenerateSecret(serverId: string) {
  const newSecret = randomBytes(32).toString('base64url');
  const newFingerprint = deriveFingerprint(newSecret);
  const [project] = await db
    .update(widgetProjects)
    .set({ apiSecretHash: newSecret, apiKey: newFingerprint, updatedAt: new Date() })
    .where(eq(widgetProjects.serverId, serverId))
    .returning({ id: widgetProjects.id });

  if (!project) throw new Error('Widget project not found');
  return { apiSecret: newSecret };
}

/**
 * List all public, enabled widget projects with ticket counts.
 */
export async function listPublicProjects() {
  const projects = await db
    .select({
      id: widgetProjects.id,
      name: widgetProjects.name,
      slug: widgetProjects.slug,
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      createdAt: widgetProjects.createdAt,
    })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.enabled, true), eq(widgetProjects.isPublic, true)))
    .orderBy(desc(widgetProjects.createdAt));

  const result = [];
  for (const p of projects) {
    const channelCondition = p.channelId
      ? eq(workspaceTasks.workspaceChannelId, p.channelId)
      : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceTasks)
      .where(and(
        eq(workspaceTasks.serverId, p.serverId),
        eq(workspaceTasks.visibility, 'public'),
        eq(workspaceTasks.moderationStatus, 'approved'),
        isNull(workspaceTasks.deletedAt),
        ...(channelCondition ? [channelCondition] : []),
      ));

    result.push({
      name: p.name,
      slug: p.slug,
      createdAt: p.createdAt,
      ticketCount: Number(countRow?.count ?? 0),
    });
  }

  return result;
}

/**
 * Generate a signed widget JWT for an identified user, given the API secret.
 */
export async function generateUserTokenBySecret(
  secret: string,
  userId: string,
  userName?: string,
) {
  const fingerprint = deriveFingerprint(secret);
  const [project] = await db
    .select({
      apiKey: widgetProjects.apiKey,
      apiSecretHash: widgetProjects.apiSecretHash,
      enabled: widgetProjects.enabled,
    })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.apiKey, fingerprint), eq(widgetProjects.enabled, true)))
    .limit(1);

  if (!project) return null;

  const signingKey = new TextEncoder().encode(project.apiSecretHash);
  const token = await new jose.SignJWT({
    fp: project.apiKey,
    type: 'widget_user',
    ...(userName ? { name: userName } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(signingKey);

  return { token };
}

export async function getWidgetIntegration(serverId: string) {
  const [project] = await db
    .select()
    .from(widgetProjects)
    .where(
      and(
        eq(widgetProjects.serverId, serverId),
        eq(widgetProjects.enabled, true)
      )
    )
    .limit(1);

  return project ?? null;
}

export async function getWidgetSettings(serverId: string) {
  const [project] = await db
    .select({
      autoApprove: widgetProjects.autoApprove,
      widgetPosition: widgetProjects.widgetPosition,
      votingPeriodHours: widgetProjects.votingPeriodHours,
      isPublic: widgetProjects.isPublic,
      slug: widgetProjects.slug,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.serverId, serverId))
    .limit(1);

  if (!project) return null;

  return {
    auto_approve: project.autoApprove,
    widget_position: project.widgetPosition,
    voting_period_hours: project.votingPeriodHours,
    is_public: project.isPublic,
    slug: project.slug,
  };
}

export async function updateWidgetSettings(
  serverId: string,
  settings: {
    auto_approve?: boolean;
    widget_position?: string;
    voting_period_hours?: number;
    is_public?: boolean;
    slug?: string;
  }
) {
  await db
    .update(widgetProjects)
    .set({
      ...(settings.auto_approve !== undefined && { autoApprove: settings.auto_approve }),
      ...(settings.widget_position !== undefined && { widgetPosition: settings.widget_position }),
      ...(settings.voting_period_hours !== undefined && { votingPeriodHours: settings.voting_period_hours }),
      ...(settings.is_public !== undefined && { isPublic: settings.is_public }),
      ...(settings.slug !== undefined && { slug: settings.slug }),
      updatedAt: new Date(),
    })
    .where(eq(widgetProjects.serverId, serverId));
}

// ============================================================================
// Title Generation
// ============================================================================

export async function generateTitle(description: string): Promise<string> {
  const fallback = description.split('\n')[0].slice(0, 80).trim() || description.slice(0, 80).trim();

  let apiKey: string | undefined;
  try {
    const { getSettings } = await import('./SettingsService');
    const settings = await getSettings();
    apiKey = settings.claudeApiKey;
  } catch {
    // ignore
  }

  if (!apiKey) return fallback;

  try {
    const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey });

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: `Generate a concise title (max 10 words) for this feature request or bug report. Reply with only the title, no quotes or punctuation at the end.\n\n${description}`,
        },
      ],
    });

    const text =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    return text || fallback;
  } catch {
    return fallback;
  }
}
