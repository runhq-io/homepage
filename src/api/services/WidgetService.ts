/**
 * WidgetService
 *
 * Handles widget authentication (3 modes), ticket CRUD, voting,
 * project management, and AI title generation.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../../db/index';
import {
  widgetProjects,
  widgetUsers,
  widgetTickets,
  widgetVotes,
  workspaceTasks,
  servers,
} from '../../db/schema';
import { eq, and, ne, desc, sql, inArray, isNull } from 'drizzle-orm';
import { fetchFromServer } from './ServerService';

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
  widgetPosition: string | null;
  serverId: string;
  channelId: string | null;
}

type CombinedWidgetTicket = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';
  moderationStatus: 'pending' | 'approved' | 'rejected';
  isPrivate: boolean;
  source: string;
  widgetUserId: string | null;
  yesVotes: number;
  noVotes: number;
  votingEndsAt: Date | null;
  syncStatus: 'synced' | 'pending';
  flyTodoId: string | null;
  createdAt: Date;
  updatedAt: Date;
  userVote: boolean | null;
  canVote: boolean;
};

// ============================================================================
// Helpers
// ============================================================================

async function getWidgetProjectContext(projectId: string): Promise<WidgetProjectContext | null> {
  const [project] = await db
    .select({
      id: widgetProjects.id,
      name: widgetProjects.name,
      widgetPosition: widgetProjects.widgetPosition,
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  return project ?? null;
}

function buildPublicWorkspaceTaskFilter(project: WidgetProjectContext) {
  if (project.channelId) {
    return and(
      eq(workspaceTasks.serverId, project.serverId),
      eq(workspaceTasks.workspaceChannelId, project.channelId),
      eq(workspaceTasks.visibility, 'public'),
      eq(workspaceTasks.sourceType, 'workspace'),
      isNull(workspaceTasks.deletedAt),
    );
  }

  return and(
    eq(workspaceTasks.serverId, project.serverId),
    eq(workspaceTasks.visibility, 'public'),
    eq(workspaceTasks.sourceType, 'workspace'),
    isNull(workspaceTasks.deletedAt),
  );
}

function mapWorkspaceTaskToWidgetTicket(
  projectId: string,
  task: {
    id: string;
    title: string;
    description: string | null;
    status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';
    upvoteCount: number;
    createdAt: Date;
    updatedAt: Date;
  }
): CombinedWidgetTicket {
  return {
    id: task.id,
    projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    moderationStatus: 'approved',
    isPrivate: false,
    source: 'workspace',
    widgetUserId: null,
    yesVotes: task.upvoteCount,
    noVotes: 0,
    votingEndsAt: null,
    syncStatus: 'synced',
    flyTodoId: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    userVote: null,
    canVote: false,
  };
}

function base64urlDecode(str: string): string {
  // Replace URL-safe chars and add padding
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

async function recountVotes(ticketId: string): Promise<void> {
  const votes = await db
    .select({ value: widgetVotes.value })
    .from(widgetVotes)
    .where(eq(widgetVotes.ticketId, ticketId));

  const yesVotes = votes.filter((v) => v.value === true).length;
  const noVotes = votes.filter((v) => v.value === false).length;

  await db
    .update(widgetTickets)
    .set({ yesVotes, noVotes, updatedAt: new Date() })
    .where(eq(widgetTickets.id, ticketId));
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

  // ---- Mode 3: Signed JWT {payload}.{signature} ----
  const payloadB64 = token.slice(0, dotIndex);
  const sigB64 = token.slice(dotIndex + 1);

  let payload: { sub?: string; name?: string; fp: string; iat?: number };
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }

  if (!payload.fp) return null;

  const [project] = await db
    .select({
      id: widgetProjects.id,
      slug: widgetProjects.slug,
      enabled: widgetProjects.enabled,
      apiSecretHash: widgetProjects.apiSecretHash,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.apiKey, payload.fp))
    .limit(1);

  if (!project || !project.enabled) return null;

  // Verify HMAC-SHA256 signature
  const expected = createHmac('sha256', project.apiSecretHash)
    .update(payloadB64)
    .digest('base64url');

  let sigValid = false;
  try {
    sigValid = timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(sigB64, 'utf8')
    );
  } catch {
    return null;
  }
  if (!sigValid) return null;

  // If sub is provided, upsert a widgetUser for identified submissions
  let widgetUserId: string | undefined;
  if (payload.sub) {
    const [existing] = await db
      .select({ id: widgetUsers.id })
      .from(widgetUsers)
      .where(
        and(
          eq(widgetUsers.projectId, project.id),
          eq(widgetUsers.externalUserId, payload.sub)
        )
      )
      .limit(1);

    if (existing) {
      if (payload.name) {
        await db
          .update(widgetUsers)
          .set({ name: payload.name })
          .where(eq(widgetUsers.id, existing.id));
      }
      widgetUserId = existing.id;
    } else {
      const [inserted] = await db
        .insert(widgetUsers)
        .values({
          projectId: project.id,
          externalUserId: payload.sub,
          name: payload.name,
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

  const widgetRows = await db
    .select()
    .from(widgetTickets)
    .where(
      and(
        eq(widgetTickets.projectId, projectId),
        ne(widgetTickets.moderationStatus, 'rejected'),
        eq(widgetTickets.isPrivate, false),
      )
    )
    .orderBy(desc(widgetTickets.createdAt))
    .limit(50);

  const workspaceRows = project
    ? await db
        .select({
          id: workspaceTasks.id,
          title: workspaceTasks.title,
          description: workspaceTasks.description,
          status: workspaceTasks.status,
          upvoteCount: workspaceTasks.upvoteCount,
          createdAt: workspaceTasks.createdAt,
          updatedAt: workspaceTasks.updatedAt,
        })
        .from(workspaceTasks)
        .where(buildPublicWorkspaceTaskFilter(project))
        .orderBy(desc(workspaceTasks.createdAt))
        .limit(50)
    : [];

  // Fetch votes for identified user
  let userVoteMap: Map<string, boolean> = new Map();
  if (widgetUserId && widgetRows.length > 0) {
    const ticketIds = widgetRows.map((t) => t.id);
    const votes = await db
      .select({ ticketId: widgetVotes.ticketId, value: widgetVotes.value })
      .from(widgetVotes)
      .where(
        and(
          inArray(widgetVotes.ticketId, ticketIds),
          eq(widgetVotes.widgetUserId, widgetUserId)
        )
      );
    for (const v of votes) {
      userVoteMap.set(v.ticketId, v.value);
    }
  }

  const widgetTicketsWithVotes: CombinedWidgetTicket[] = widgetRows.map((t) => ({
    ...t,
    userVote: userVoteMap.has(t.id) ? userVoteMap.get(t.id) ?? null : null,
    canVote: true,
  }));

  const canonicalTickets = workspaceRows.map((task) =>
    mapWorkspaceTaskToWidgetTicket(projectId, task)
  );

  const tickets = [...widgetTicketsWithVotes, ...canonicalTickets]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);

  return {
    projectName: project?.name ?? '',
    position: project?.widgetPosition ?? null,
    isIdentified: !!widgetUserId,
    tickets,
  };
}

export async function createTicket(
  projectId: string,
  widgetUserId: string | undefined,
  opts: { title?: string; description?: string; isPrivate?: boolean }
) {
  const [project] = await db
    .select({
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

  const [ticket] = await db
    .insert(widgetTickets)
    .values({
      projectId,
      title,
      description: opts.description,
      isPrivate: opts.isPrivate ?? false,
      widgetUserId: widgetUserId ?? null,
      moderationStatus,
      votingEndsAt,
    })
    .returning();

  // Best-effort push to Fly server as a todo
  syncTicketToServer(ticket.id, projectId, title, opts.description).catch((err) => {
    console.warn('[WidgetService] Failed to sync ticket to server:', err);
  });

  return ticket;
}

export async function listMyTickets(
  projectId: string,
  widgetUserId: string
) {
  return db
    .select()
    .from(widgetTickets)
    .where(
      and(
        eq(widgetTickets.projectId, projectId),
        eq(widgetTickets.widgetUserId, widgetUserId)
      )
    )
    .orderBy(desc(widgetTickets.createdAt))
    .limit(50);
}

export async function getTicketStats(projectId: string) {
  const [widgetResult] = await db
    .select({
      totalOpen: sql<number>`count(*) filter (where ${widgetTickets.moderationStatus} = 'approved' and ${widgetTickets.isPrivate} = false and ${widgetTickets.status} not in ('done', 'cancelled'))`,
      totalDone: sql<number>`count(*) filter (where ${widgetTickets.moderationStatus} = 'approved' and ${widgetTickets.isPrivate} = false and ${widgetTickets.status} = 'done')`,
    })
    .from(widgetTickets)
    .where(eq(widgetTickets.projectId, projectId));

  const project = await getWidgetProjectContext(projectId);
  const [workspaceResult] = project
    ? await db
        .select({
          totalOpen: sql<number>`count(*) filter (where ${workspaceTasks.status} not in ('done', 'cancelled'))`,
          totalDone: sql<number>`count(*) filter (where ${workspaceTasks.status} = 'done')`,
        })
        .from(workspaceTasks)
        .where(buildPublicWorkspaceTaskFilter(project))
    : [{ totalOpen: 0, totalDone: 0 }];

  return {
    totalOpen: Number(widgetResult?.totalOpen ?? 0) + Number(workspaceResult?.totalOpen ?? 0),
    totalDone: Number(widgetResult?.totalDone ?? 0) + Number(workspaceResult?.totalDone ?? 0),
  };
}

// ============================================================================
// Vote Operations
// ============================================================================

export async function castVote(
  ticketId: string,
  widgetUserId: string,
  value: boolean
) {
  const [ticket] = await db
    .select({
      id: widgetTickets.id,
      moderationStatus: widgetTickets.moderationStatus,
      votingEndsAt: widgetTickets.votingEndsAt,
    })
    .from(widgetTickets)
    .where(eq(widgetTickets.id, ticketId))
    .limit(1);

  if (!ticket) throw new Error('Ticket not found');
  if (ticket.moderationStatus !== 'approved') {
    throw new Error('Voting is only allowed on approved tickets');
  }
  if (ticket.votingEndsAt && new Date() > ticket.votingEndsAt) {
    throw new Error('Voting period has ended');
  }

  await db
    .insert(widgetVotes)
    .values({ ticketId, widgetUserId, value })
    .onConflictDoUpdate({
      target: [widgetVotes.ticketId, widgetVotes.widgetUserId],
      set: { value },
    });

  await recountVotes(ticketId);
}

export async function retractVote(ticketId: string, widgetUserId: string) {
  await db
    .delete(widgetVotes)
    .where(
      and(
        eq(widgetVotes.ticketId, ticketId),
        eq(widgetVotes.widgetUserId, widgetUserId)
      )
    );

  await recountVotes(ticketId);
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
  const slugSuffix = randomBytes(4).toString('hex'); // used only when no existing slug
  // Reuse existing slug on re-enable so URLs don't change; generate new one otherwise
  const slug = existing?.slug ?? generateSlug(opts.name, slugSuffix);

  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId,
      name: opts.name,
      slug,
      apiKey,
      apiSecretHash: apiSecret, // Store the raw secret for HMAC-SHA256 verification
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

  // Get ticket counts per project
  const result = [];
  for (const p of projects) {
    const [widgetCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(widgetTickets)
      .where(
        and(
          eq(widgetTickets.projectId, p.id),
          ne(widgetTickets.moderationStatus, 'rejected'),
          eq(widgetTickets.isPrivate, false),
        )
      );

    const workspaceWhere = p.channelId
      ? and(
          eq(workspaceTasks.serverId, p.serverId),
          eq(workspaceTasks.workspaceChannelId, p.channelId),
          eq(workspaceTasks.visibility, 'public'),
          eq(workspaceTasks.sourceType, 'workspace'),
          isNull(workspaceTasks.deletedAt),
        )
      : and(
          eq(workspaceTasks.serverId, p.serverId),
          eq(workspaceTasks.visibility, 'public'),
          eq(workspaceTasks.sourceType, 'workspace'),
          isNull(workspaceTasks.deletedAt),
        );

    const [workspaceCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceTasks)
      .where(workspaceWhere);

    result.push({
      name: p.name,
      slug: p.slug,
      createdAt: p.createdAt,
      ticketCount: Number(widgetCountRow?.count ?? 0) + Number(workspaceCountRow?.count ?? 0),
    });
  }

  return result;
}

/**
 * Generate a signed widget JWT for an identified user, given the API secret.
 * Derives a fingerprint from the secret to look up the project.
 * Used server-side only — the secret comes from env config, never from the client.
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

  const payload = {
    sub: userId,
    name: userName || undefined,
    fp: project.apiKey,
    iat: Math.floor(Date.now() / 1000),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', project.apiSecretHash)
    .update(payloadB64)
    .digest('base64url');

  return { token: `${payloadB64}.${signature}` };
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

// ============================================================================
// Ticket Sync (BE ↔ Fly Server)
// ============================================================================

/**
 * Best-effort push: create a todo on the Fly server for a new widget ticket.
 * If the server is down, the ticket stays syncStatus='pending' and will be
 * picked up on the next server wake via the unsynced tickets endpoint.
 */
async function syncTicketToServer(
  ticketId: string,
  projectId: string,
  title: string,
  description?: string,
) {
  // Look up the widget project to get serverId and channelId
  const [wp] = await db
    .select({
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      slug: widgetProjects.slug,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  if (!wp?.channelId) return;

  // Look up the server record
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, wp.serverId))
    .limit(1);

  if (!server?.ownerId) return;

  // Look up ticket vote counts and submitter name
  const [ticket] = await db
    .select({ yesVotes: widgetTickets.yesVotes, noVotes: widgetTickets.noVotes, widgetUserId: widgetTickets.widgetUserId })
    .from(widgetTickets)
    .where(eq(widgetTickets.id, ticketId))
    .limit(1);

  let submitterName: string | undefined;
  if (ticket?.widgetUserId) {
    const [wu] = await db
      .select({ name: widgetUsers.name })
      .from(widgetUsers)
      .where(eq(widgetUsers.id, ticket.widgetUserId))
      .limit(1);
    submitterName = wu?.name || undefined;
  }

  const sourceVoteData = JSON.stringify({
    yes: ticket?.yesVotes ?? 0,
    no: ticket?.noVotes ?? 0,
    submittedBy: submitterName || 'Anonymous',
  });

  const result = await fetchFromServer<{ success: boolean; data?: { id: string } }>(
    server,
    server.ownerId,
    '/api/todos',
    {
      method: 'POST',
      body: {
        title,
        description: description || undefined,
        channelId: wp.channelId,
        sourceType: 'widget',
        sourceId: ticketId,
        sourceUrl: `https://runhq.io/project/${wp.slug}`,
        sourceVoteData,
      },
    },
  );

  if (result.success && result.data?.id) {
    await db
      .update(widgetTickets)
      .set({ syncStatus: 'synced', flyTodoId: result.data.id })
      .where(eq(widgetTickets.id, ticketId));
  }
}

/**
 * Get all pending-sync tickets for widget projects belonging to a given server.
 * Called by the Fly server on wake to pull tickets it missed while sleeping.
 */
export async function getUnsyncedTickets(serverId: string) {
  const rows = await db
    .select({
      id: widgetTickets.id,
      title: widgetTickets.title,
      description: widgetTickets.description,
      projectId: widgetTickets.projectId,
      channelId: widgetProjects.channelId,
      slug: widgetProjects.slug,
      yesVotes: widgetTickets.yesVotes,
      noVotes: widgetTickets.noVotes,
      widgetUserId: widgetTickets.widgetUserId,
    })
    .from(widgetTickets)
    .innerJoin(widgetProjects, eq(widgetTickets.projectId, widgetProjects.id))
    .where(
      and(
        eq(widgetProjects.serverId, serverId),
        eq(widgetTickets.syncStatus, 'pending'),
      ),
    )
    .limit(200);

  // Resolve submitter names
  const result = [];
  for (const row of rows) {
    let submittedBy = 'Anonymous';
    if (row.widgetUserId) {
      const [wu] = await db
        .select({ name: widgetUsers.name })
        .from(widgetUsers)
        .where(eq(widgetUsers.id, row.widgetUserId))
        .limit(1);
      if (wu?.name) submittedBy = wu.name;
    }
    result.push({
      id: row.id,
      title: row.title,
      description: row.description,
      channelId: row.channelId,
      slug: row.slug,
      sourceVoteData: JSON.stringify({ yes: row.yesVotes, no: row.noVotes, submittedBy }),
    });
  }

  return result;
}

/**
 * Mark tickets as synced and store their Fly-side todo IDs.
 */
export async function markTicketsSynced(
  ticketIds: string[],
  flyTodoIds: Record<string, string>,
) {
  await db.transaction(async (tx) => {
    for (const ticketId of ticketIds) {
      await tx
        .update(widgetTickets)
        .set({
          syncStatus: 'synced',
          flyTodoId: flyTodoIds[ticketId] || null,
          updatedAt: new Date(),
        })
        .where(eq(widgetTickets.id, ticketId));
    }
  });
}

/**
 * Update a ticket's status (called by Fly server when todo status changes).
 */
export async function updateTicketStatus(
  ticketId: string,
  status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'cancelled',
) {
  await db
    .update(widgetTickets)
    .set({ status, updatedAt: new Date() })
    .where(eq(widgetTickets.id, ticketId));
}
