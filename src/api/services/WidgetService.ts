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
  serverMembers,
  users,
  widgetExposedAgents,
} from '../../db/schema';
import { eq, and, ne, desc, sql, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import type { CanonicalTaskActorType, CanonicalTaskComment } from '@runhq/server-protocol';
import * as WorkspaceTaskService from './WorkspaceTaskService';
import { TaskAttachmentStorageService } from './TaskAttachmentStorageService';
import * as ServerService from './ServerService';
import * as ClarifierService from './ClarifierService';
import type { ClarificationQuestion } from './ClarifierService';
import {
  RW_SESSION_COOKIE,
  verifyRwSession,
  csrfTokenFor,
  verifyCsrfToken,
  normalizeOrigin,
} from './WidgetCookieAuth';

const attachmentStorage = new TaskAttachmentStorageService();

/**
 * Lookup key for widget rows.
 *
 * Widget identity is the project: admin routes resolve the row by
 * (serverId, workspaceProjectId). `channelId` is the mutable target todo
 * channel the widget feeds, not the lookup key.
 */
export type WidgetLookup = { workspaceProjectId: string };

function widgetLookupCondition(lookup: WidgetLookup | undefined) {
  if (!lookup) return undefined;
  return eq(widgetProjects.workspaceProjectId, lookup.workspaceProjectId);
}

/**
 * Maximum age of a widget_user JWT regardless of the `exp` value the
 * customer's issuer sets. 24h matches what `signWidgetUserJwt` mints
 * server-side; tokens minted by customer backends cannot exceed this even
 * with a longer `exp`.
 */
export const WIDGET_JWT_MAX_TOKEN_AGE = '24h';

// ============================================================================
// Types
// ============================================================================

export type WidgetPermission = 'assign_agent';
export type WidgetAuthSource = 'app' | 'runhq' | 'anon';

export interface WidgetAuthResult {
  projectId: string;
  projectSlug: string;
  widgetUserId?: string;
  /** True when the request was authenticated (signed JWT or rw_session cookie that resolved to a workspace member) */
  authenticated: boolean;
  /** Permissions derived from JWT role claim ∩ project whitelist (or auto-granted for workspace admins on the runhq path). */
  permissions: ReadonlySet<WidgetPermission>;
  /** Subset of project's whitelist that this user's JWT carried — used for audit attribution. */
  matchedRoles: string[];
  /** Which of the three identity paths produced this result. Influences write-path CSRF requirements. */
  authSource: WidgetAuthSource;
  /**
   * RunHQ user ID when authSource === 'runhq'. NOT exposed to the widget;
   * used internally for audit attribution and admin checks.
   */
  runhqUserId?: string;
  /** CSRF token for the cookie-authenticated session. Returned to the client; required on all writes when authSource === 'runhq'. */
  csrfToken?: string;
  /** Display name resolved from the underlying identity (RunHQ user, JWT name claim, etc.). */
  displayName?: string;
  /** Avatar URL (RunHQ users today; null for app users unless the JWT supplies it). */
  avatarUrl?: string | null;
}

interface HonoRequest {
  header(name: string): string | undefined;
  /**
   * HTTP method — used by the cookie-auth path to decide when CSRF is required.
   * Optional so unit tests can pass minimal mock requests for read-only paths.
   */
  method?: string;
  raw?: { headers: Headers };
}

/** Methods that change server state and therefore require CSRF protection on the cookie path. */
const CSRF_PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface WidgetProjectContext {
  id: string;
  name: string;
  slug: string;
  widgetPosition: string | null;
  widgetLanguage: string | null;
  isPublic: boolean;
  widgetLoginUrl: string | null;
  allowedOrigins: string[];
  autoRecognizeRunhqMembers: boolean;
  widgetAgentAssignmentEnabled: boolean;
  serverId: string;
  channelId: string | null;
  widgetChatAgentEntityId: string | null;
}

type WidgetTicketResponse = {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'planned' | 'in_progress' | 'needs_review' | 'done' | 'deployed' | 'cancelled';
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
  completedAt: Date | null;
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
    createdByType: CanonicalTaskActorType;
    externalUserId: string | null;
    commentsDisabled: boolean;
    /** Name of the currently-assigned agent, if any */
    assignedAgentName: string | null;
    /** The external user who last triggered an assignment, or null if it was internal */
    lastTriager: { name: string | null; at: string } | null;
  };
  /** Whether the requesting user owns this ticket */
  isOwner: boolean;
  /** Whether the ticket can be edited/deleted by its owner right now */
  isEditable: boolean;
  comments: Array<{
    id: string;
    body: string;
    authorName: string | null;
    createdByType: CanonicalTaskActorType;
    externalUserId: string | null;
    isAuthorOfCurrentUser: boolean;
    canEdit: boolean;
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
  /**
   * The most recent clarification session for this ticket, or null if none exists.
   *
   * `openQuestions` is populated ONLY when the requester is the clarification's
   * widgetUserId (the assigner who must answer) AND the status is 'asking'.
   * All other viewers receive an empty array to prevent question-card leakage.
   */
  clarification: {
    /** The clarification row id — required by the widget to POST /clarify-answer. */
    id: string;
    status: 'asking' | 'ready' | 'skipped' | 'duplicate' | 'started';
    round: number;
    openQuestions: ClarificationQuestion[];
    /**
     * When status='duplicate': the id of the workspace_tasks row this ticket
     * duplicates. Null otherwise. Populated from widget_clarifications.duplicate_of_task_id.
     */
    duplicateOf: string | null;
  } | null;
  /**
   * The linked pull request for this ticket, derived from the most recent
   * `pr_linked` activity. null if no PR has been linked.
   * Visible to all viewers — the PR link is not sensitive.
   */
  linkedPr: { number: number; url: string; state: string; repoBranch?: string | null } | null;
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

/**
 * Derive the most recent linked PR from an activity feed (already loaded).
 * Returns null if no valid pr_linked activity exists.
 * Defensively validates that number is a number and url is a string.
 */
function deriveLinkedPr(
  activity: Array<{ type: string; metadata?: Record<string, unknown> | null }>,
): PublicTicketDetail['linkedPr'] {
  // activity is ordered by createdAt asc; scan in reverse for the most recent
  for (let i = activity.length - 1; i >= 0; i--) {
    const entry = activity[i];
    if (entry.type !== 'pr_linked') continue;
    const m = entry.metadata;
    if (!m) continue;
    const number = m.number;
    const url = m.url;
    // Defensive validation — malformed metadata must not surface
    if (typeof number !== 'number' || typeof url !== 'string') continue;
    const state = typeof m.state === 'string' ? m.state : 'open';
    const repoBranch = typeof m.repoBranch === 'string' ? m.repoBranch : null;
    return { number, url, state, repoBranch };
  }
  return null;
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
      widgetLanguage: widgetProjects.widgetLanguage,
      isPublic: widgetProjects.isPublic,
      widgetLoginUrl: widgetProjects.widgetLoginUrl,
      allowedOrigins: widgetProjects.allowedOrigins,
      autoRecognizeRunhqMembers: widgetProjects.autoRecognizeRunhqMembers,
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      widgetChatAgentEntityId: widgetProjects.widgetChatAgentEntityId,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);

  return project ?? null;
}

/**
 * Look up a project by its slug for cookie-auth pre-resolution. The cookie
 * itself carries no project info, so the widget tells the server which
 * project it's running for via `X-RW-Project: <slug>`.
 */
async function getWidgetProjectBySlug(slug: string): Promise<WidgetProjectContext | null> {
  const [project] = await db
    .select({
      id: widgetProjects.id,
      name: widgetProjects.name,
      slug: widgetProjects.slug,
      widgetPosition: widgetProjects.widgetPosition,
      widgetLanguage: widgetProjects.widgetLanguage,
      isPublic: widgetProjects.isPublic,
      widgetLoginUrl: widgetProjects.widgetLoginUrl,
      allowedOrigins: widgetProjects.allowedOrigins,
      autoRecognizeRunhqMembers: widgetProjects.autoRecognizeRunhqMembers,
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      serverId: widgetProjects.serverId,
      channelId: widgetProjects.channelId,
      widgetChatAgentEntityId: widgetProjects.widgetChatAgentEntityId,
    })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.slug, slug), eq(widgetProjects.enabled, true)))
    .limit(1);

  return project ?? null;
}

/**
 * Whether ANY enabled widget project lists this origin in its
 * `allowed_origins`. Used by the HTTP layer to decide whether to echo
 * credentialed CORS headers (Allow-Credentials + reflected Origin) for
 * a given request. Per-project membership/auth is still enforced by
 * `authenticateWidget`; this only widens the CORS envelope so the
 * browser will SEND cookies in the first place.
 */
export async function isOriginAllowlisted(origin: string): Promise<boolean> {
  // PostgreSQL `text[] @> ARRAY[$1]` checks if the column contains the
  // supplied value. Faster than a sequential scan when the list is short.
  const [match] = await db
    .select({ id: widgetProjects.id })
    .from(widgetProjects)
    .where(
      and(
        eq(widgetProjects.enabled, true),
        sql`${widgetProjects.allowedOrigins} @> ARRAY[${origin}]::text[]`,
      ),
    )
    .limit(1);
  return !!match;
}

/**
 * Returns membership status (and admin flag) for a (server, user) pair.
 * Returns null when the user is not a member at all.
 */
async function getServerMembership(
  serverId: string,
  userId: string,
): Promise<{ role: string; isAdmin: boolean } | null> {
  const [row] = await db
    .select({
      role: serverMembers.role,
      isAdmin: serverMembers.isAdmin,
    })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

function getHomepageUrl(): string {
  const cloudApiUrl = process.env.CLOUD_API_URL || 'https://console.runhq.io';
  return cloudApiUrl
    .replace('console-staging.', 'staging.')
    .replace('console.', 'www.');
}

/**
 * Whitelist-validates a URL provided by a project owner (currently
 * widget_login_url). Allows only http: and https:; rejects javascript:,
 * data:, file:, and any other scheme regardless of how the URL parses.
 */
function isSafeHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Build a filter for tasks visible in the widget for a given project.
 * Includes both widget-submitted and workspace-created public tasks.
 */
function buildWidgetVisibleFilter(project: WidgetProjectContext) {
  // Moderation gating was removed — workflow status (pending/planned/
  // in_progress/done/etc.) covers triage now. moderation_status stays
  // as a column for back-compat but is no longer consulted.
  const baseConditions = [
    eq(workspaceTasks.serverId, project.serverId),
    isNull(workspaceTasks.deletedAt),
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
    completedAt: task.completedAt,
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

const EMPTY_PERMISSIONS: ReadonlySet<WidgetPermission> = new Set();

/**
 * Owner-or-admin check on a server_members row. Owner rows carry
 * role='owner' with is_admin=false — is_admin is the workspace-derived
 * mirror, set only for workspace-PROMOTED admins. Same shape as
 * ServerService.checkCloudOpPermission.
 */
function isOwnerOrAdmin(membership: { role: string; isAdmin: boolean }): boolean {
  return membership.role === 'owner' || membership.isAdmin === true;
}

interface PermissionPolicyRow {
  widgetAgentAssignmentEnabled: boolean;
  widgetAssignRoles: string[];
  widgetRoleClaimName: string;
}

interface PermissionDerivation {
  permissions: ReadonlySet<WidgetPermission>;
  matchedRoles: string[];
}

function derivePermissions(
  policy: PermissionPolicyRow,
  jwtPayload: jose.JWTPayload,
): PermissionDerivation {
  if (!policy.widgetAgentAssignmentEnabled) return { permissions: EMPTY_PERMISSIONS, matchedRoles: [] };
  if (policy.widgetAssignRoles.length === 0) return { permissions: EMPTY_PERMISSIONS, matchedRoles: [] };
  const claim = jwtPayload[policy.widgetRoleClaimName];
  if (!Array.isArray(claim)) return { permissions: EMPTY_PERMISSIONS, matchedRoles: [] };
  const userRoles = claim.filter((r): r is string => typeof r === 'string');
  const matchedRoles = userRoles.filter(r => policy.widgetAssignRoles.includes(r));
  if (matchedRoles.length === 0) return { permissions: EMPTY_PERMISSIONS, matchedRoles: [] };
  return { permissions: new Set<WidgetPermission>(['assign_agent']), matchedRoles };
}

/**
 * Parses a single named cookie out of a `Cookie:` header. Hono's
 * `getCookie` helper requires the Context, but `authenticateWidget`
 * accepts a raw HonoRequest for unit-testability. Manual parse keeps
 * the API surface narrow.
 */
function readCookie(req: HonoRequest, name: string): string | null {
  const header = req.header('Cookie');
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Authenticates a widget request using one of four modes, in priority order.
 *
 * Identity precedence: runhq > app > anon. The cookie path is tried first; if
 * it doesn't qualify (cookie absent, user not a member, origin not allowlisted,
 * project not opted in), we fall through silently to the existing token paths.
 *
 *   0. RunHQ-member cookie — rw_session + X-RW-Project + Origin ∈ allowed_origins
 *   1. Public slug         — no Authorization, X-RW-Project: {slug}
 *   2. Raw API key         — Authorization: Bearer rw_xxx (no dot)
 *   3. Signed JWT          — Authorization: Bearer {payload}.{signature}
 */
export async function authenticateWidget(
  req: HonoRequest
): Promise<WidgetAuthResult | null> {
  const authHeader = req.header('Authorization');
  const projectSlugHeader = req.header('X-RW-Project');
  const originHeader = req.header('Origin');

  // ---- Mode 0: rw_session cookie (RunHQ workspace member) ----
  // Highest priority. Tried first so cookie-recognized members never get
  // mis-attributed to the customer's JWT identity even when both are present.
  const rwSession = readCookie(req, RW_SESSION_COOKIE);
  if (rwSession && projectSlugHeader && originHeader) {
    const verified = await verifyRwSession(rwSession);
    if (verified) {
      const project = await getWidgetProjectBySlug(projectSlugHeader);
      if (
        project &&
        project.autoRecognizeRunhqMembers &&
        project.allowedOrigins.includes(originHeader)
      ) {
        const membership = await getServerMembership(project.serverId, verified.userId);
        if (membership) {
          // CSRF check — required on all state-changing methods. We do this
          // BEFORE the DB upsert so a forged write doesn't accidentally
          // create/refresh a widget_users row. Reads (GET, plus the
          // identity bootstrap itself) are exempt because they're idempotent
          // and intrinsically CSRF-safe.
          if (req.method && CSRF_PROTECTED_METHODS.has(req.method.toUpperCase())) {
            const presented = req.header('X-RunHQ-CSRF');
            if (!verifyCsrfToken(presented, verified.userId, verified.iat)) {
              return null; // 401 from caller; treat invalid CSRF as auth failure
            }
          }

          // Upsert the widget_user under auth_source='runhq' so this row
          // never collides with an app-path row for the same human.
          const externalUserId = `runhq:${verified.userId}`;
          let widgetUserId: string;
          const [existing] = await db
            .select({ id: widgetUsers.id })
            .from(widgetUsers)
            .where(
              and(
                eq(widgetUsers.projectId, project.id),
                eq(widgetUsers.externalUserId, externalUserId),
                eq(widgetUsers.authSource, 'runhq'),
              ),
            )
            .limit(1);

          // Pull fresh display name from users table on every auth — name
          // changes in console should reflect immediately in the widget UI.
          const [user] = await db
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(eq(users.id, verified.userId))
            .limit(1);
          const displayName = user?.name || user?.email || 'RunHQ user';

          if (existing) {
            widgetUserId = existing.id;
            await db
              .update(widgetUsers)
              .set({ name: displayName })
              .where(eq(widgetUsers.id, existing.id));
          } else {
            const [inserted] = await db
              .insert(widgetUsers)
              .values({
                projectId: project.id,
                externalUserId,
                authSource: 'runhq',
                name: displayName,
              })
              .returning({ id: widgetUsers.id });
            widgetUserId = inserted.id;
          }

          // Workspace owners/admins auto-grant the assign_agent permission
          // when the project has triager-assignment enabled. Regular members
          // continue to need explicit role-claim configuration via JWT —
          // expanding the trust boundary further requires explicit owner opt-in.
          const isAdmin = isOwnerOrAdmin(membership);
          const permissions: ReadonlySet<WidgetPermission> =
            isAdmin && project.widgetAgentAssignmentEnabled
              ? new Set<WidgetPermission>(['assign_agent'])
              : EMPTY_PERMISSIONS;

          return {
            projectId: project.id,
            projectSlug: project.slug,
            widgetUserId,
            authenticated: true,
            permissions,
            matchedRoles: isAdmin ? ['admin'] : [],
            authSource: 'runhq',
            runhqUserId: verified.userId,
            csrfToken: csrfTokenFor(verified.userId, verified.iat),
            displayName,
            avatarUrl: null,
          };
        }
      }
    }
    // Cookie present but didn't qualify — fall through to the other modes.
    // Crucially: do NOT short-circuit to anonymous. The same request might
    // still carry a valid app JWT we should honor.
  }

  // ---- Mode 1: Public slug (no auth header) ----
  if (!authHeader && projectSlugHeader) {
    const [project] = await db
      .select({ id: widgetProjects.id, slug: widgetProjects.slug, enabled: widgetProjects.enabled, isPublic: widgetProjects.isPublic })
      .from(widgetProjects)
      .where(eq(widgetProjects.slug, projectSlugHeader))
      .limit(1);

    if (!project || !project.enabled || !project.isPublic) return null;
    return {
      projectId: project.id,
      projectSlug: project.slug,
      authenticated: false,
      permissions: EMPTY_PERMISSIONS,
      matchedRoles: [],
      authSource: 'anon',
    };
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
    return {
      projectId: project.id,
      projectSlug: project.slug,
      authenticated: false,
      permissions: EMPTY_PERMISSIONS,
      matchedRoles: [],
      authSource: 'anon',
    };
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
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      widgetAssignRoles: widgetProjects.widgetAssignRoles,
      widgetRoleClaimName: widgetProjects.widgetRoleClaimName,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.apiKey, decoded.fp))
    .limit(1);

  if (!project || !project.enabled) return null;

  // Verify signature, expiry, and type using jose.
  // - requiredClaims: ['exp'] forces customer issuers to set an expiry.
  //   Without this, jose only rejects exp when present — a missing exp
  //   would let leaked tokens live forever.
  // - maxTokenAge caps how long any single token can be valid even if the
  //   customer sets a longer exp (e.g. a 10-year exp by mistake).
  let payload: jose.JWTPayload;
  try {
    const signingKey = new TextEncoder().encode(project.apiSecretHash);
    const { payload: verified } = await jose.jwtVerify(token, signingKey, {
      algorithms: ['HS256'],
      requiredClaims: ['exp'],
      maxTokenAge: WIDGET_JWT_MAX_TOKEN_AGE,
    });
    if (verified.type !== 'widget_user') return null;
    payload = verified;
  } catch {
    return null;
  }

  // If sub is provided, upsert a widgetUser for identified submissions
  let widgetUserId: string | undefined;
  // Accept a numeric `sub` too. Integer user ids are ubiquitous (every
  // PHP/SQL app: `'sub' => $user->id`). Previously a number sub was
  // silently dropped here → authenticated-but-unidentified → 401 on every
  // write, with no authError/diagnostic. Coerce to a string so the
  // widget_users mapping is stable regardless of JSON number-vs-string.
  const sub =
    typeof payload.sub === 'string' && payload.sub
      ? payload.sub
      : typeof payload.sub === 'number' && Number.isFinite(payload.sub)
        ? String(payload.sub)
        : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  if (sub) {
    const [existing] = await db
      .select({ id: widgetUsers.id })
      .from(widgetUsers)
      .where(
        and(
          eq(widgetUsers.projectId, project.id),
          eq(widgetUsers.externalUserId, sub),
          eq(widgetUsers.authSource, 'app'),
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
          authSource: 'app',
          name,
        })
        .returning({ id: widgetUsers.id });
      widgetUserId = inserted.id;
    }
  }

  const { permissions, matchedRoles } = derivePermissions(project, payload);
  return {
    projectId: project.id,
    projectSlug: project.slug,
    widgetUserId,
    authenticated: true,
    permissions,
    matchedRoles,
    authSource: 'app',
    displayName: name,
  };
}

/**
 * Machine-readable reasons a presented widget Bearer JWT failed to
 * authenticate. Surfaced (only) to the caller that presented the token,
 * via /api/widget/identity, so a misconfigured embed reports the exact
 * defect instead of silently degrading to anonymous. Explaining why the
 * caller's *own* token is invalid is not an info leak (same contract as
 * OAuth `invalid_token` error_description).
 */
export type WidgetAuthDiagnosis =
  | 'malformed_jwt'      // not a 3-part JWT, undecodable, or missing `fp`
  | 'unknown_project'    // `fp` matches no widget project (wrong secret/fingerprint)
  | 'project_disabled'   // project exists but is disabled
  | 'signature_invalid'  // wrong signing secret
  | 'token_expired'      // `exp` in the past
  | 'token_too_old'      // exceeds WIDGET_JWT_MAX_TOKEN_AGE
  | 'missing_exp'        // required `exp` claim absent
  | 'wrong_type'         // `type` !== 'widget_user'
  | 'not_identified';    // verified but no `sub` (can't attribute submissions)

/**
 * When `authenticateWidget` returned no identity, classify *why* a
 * presented Bearer JWT was rejected. Returns `null` when there is no
 * Bearer token (genuine anonymous — nothing to report) or when the token
 * actually verifies (caller should not have asked). Re-runs the same
 * pipeline as the Mode 3 branch of `authenticateWidget`; kept separate so
 * the hot auth path keeps its simple `null` contract.
 */
export async function diagnoseWidgetBearerAuth(
  req: HonoRequest,
): Promise<WidgetAuthDiagnosis | null> {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  // Raw API-key embeds (no dot) are intentionally anonymous, not broken.
  if (token.indexOf('.') === -1) return null;

  const decoded = decodeJwtPayload(token);
  if (!decoded || typeof decoded.fp !== 'string') return 'malformed_jwt';

  const [project] = await db
    .select({
      enabled: widgetProjects.enabled,
      apiSecretHash: widgetProjects.apiSecretHash,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.apiKey, decoded.fp))
    .limit(1);

  if (!project) return 'unknown_project';
  if (!project.enabled) return 'project_disabled';

  let payload: jose.JWTPayload;
  try {
    const signingKey = new TextEncoder().encode(project.apiSecretHash);
    const { payload: verified } = await jose.jwtVerify(token, signingKey, {
      algorithms: ['HS256'],
      requiredClaims: ['exp'],
      maxTokenAge: WIDGET_JWT_MAX_TOKEN_AGE,
    });
    payload = verified;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ERR_JWT_EXPIRED') return 'token_expired';
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'signature_invalid';
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      const claim = (err as { claim?: string })?.claim;
      if (claim === 'iat') return 'token_too_old';
      return 'missing_exp';
    }
    return 'signature_invalid';
  }

  if (payload.type !== 'widget_user') return 'wrong_type';
  // Mirror authenticateWidget: a finite numeric sub is usable (coerced),
  // so only flag genuinely absent/empty subs as not_identified.
  const hasUsableSub =
    (typeof payload.sub === 'string' && !!payload.sub) ||
    (typeof payload.sub === 'number' && Number.isFinite(payload.sub));
  if (!hasUsableSub) return 'not_identified';
  return null; // token is actually valid — nothing to diagnose
}

// ============================================================================
// Ticket Operations
// ============================================================================

export interface WidgetChatBootstrapInfo {
  enabled: boolean;
  agentName: string | null;
}

/**
 * Bootstrap `chat` field for widget.js: enabled iff a support agent is
 * configured. The display name comes from the widget_exposed_agents mirror;
 * null when the chosen agent isn't mirrored (widget falls back to a generic
 * label).
 */
async function getChatBootstrapInfo(
  project: Pick<WidgetProjectContext, 'id' | 'widgetChatAgentEntityId'> | null,
): Promise<WidgetChatBootstrapInfo> {
  if (!project?.widgetChatAgentEntityId) return { enabled: false, agentName: null };
  const [agent] = await db
    .select({ name: widgetExposedAgents.agentName })
    .from(widgetExposedAgents)
    .where(and(
      eq(widgetExposedAgents.widgetProjectId, project.id),
      eq(widgetExposedAgents.agentId, project.widgetChatAgentEntityId),
    ))
    .limit(1);
  return { enabled: true, agentName: agent?.name ?? null };
}

export async function listTickets(projectId: string, widgetUserId?: string) {
  const project = await getWidgetProjectContext(projectId);

  const rows = project
    ? await db
        .select()
        .from(workspaceTasks)
        .where(and(
          buildWidgetVisibleFilter(project),
          eq(workspaceTasks.visibility, 'public'),
          sql`${workspaceTasks.status} in ('pending','planned','in_progress')`,
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
    language: project?.widgetLanguage ?? 'en',
    isIdentified: !!widgetUserId,
    isPublic: !!project?.isPublic,
    // Only surface the configured login URL to anonymous viewers of public
    // projects — that's the only audience that needs it. Authed users never
    // get redirected, and non-public projects must not leak owner config.
    loginUrl: !widgetUserId && project?.isPublic ? project.widgetLoginUrl : null,
    chat: await getChatBootstrapInfo(project),
    tickets,
  };
}

export async function listPublishedTickets(projectId: string, widgetUserId?: string) {
  const project = await getWidgetProjectContext(projectId);

  const rows = project
    ? await db
        .select()
        .from(workspaceTasks)
        .where(and(
          buildWidgetVisibleFilter(project),
          eq(workspaceTasks.visibility, 'public'), // defense-in-depth: publishing auto-promotes visibility=public upstream; still gate here
          eq(workspaceTasks.isPublished, true),
        ))
        // "Latest Updates" = recently shipped work. Sort by completedAt (when marked done),
        // not updatedAt — otherwise flipping isPublished or any later edit/vote/comment
        // would re-surface an old task to the top. Non-done published tickets keep
        // appearing (status no longer gates the feed) but sink to the bottom.
        .orderBy(sql`${workspaceTasks.completedAt} desc nulls last`)
        .limit(20)
    : [];

  let userVoteMap: Map<string, boolean> = new Map();
  if (widgetUserId && rows.length > 0) {
    const taskIds = rows.map((t) => t.id);
    const votes = await db
      .select({ taskId: workspaceTaskVotes.taskId, value: workspaceTaskVotes.value })
      .from(workspaceTaskVotes)
      .where(and(
        inArray(workspaceTaskVotes.taskId, taskIds),
        eq(workspaceTaskVotes.voterId, widgetUserId),
      ));
    for (const v of votes) userVoteMap.set(v.taskId, v.value);
  }

  const tickets = rows.map((t) => mapTaskToWidgetResponse(t, userVoteMap.get(t.id) ?? null, true));

  return {
    projectName: project?.name ?? '',
    projectSlug: project?.slug ?? '',
    homepageUrl: getHomepageUrl(),
    position: project?.widgetPosition ?? null,
    language: project?.widgetLanguage ?? 'en',
    isIdentified: !!widgetUserId,
    isPublic: !!project?.isPublic,
    loginUrl: !widgetUserId && project?.isPublic ? project.widgetLoginUrl : null,
    tickets,
  };
}

async function resolveExternalUserIds(
  projectId: string,
  rows: Array<Pick<CanonicalTaskComment, 'createdByType' | 'createdById'>>,
): Promise<Map<string, string>> {
  const ids = rows
    .filter(r => r.createdByType === 'external' && r.createdById)
    .map(r => r.createdById as string);
  if (ids.length === 0) return new Map();
  const dbRows = await db
    .select({ id: widgetUsers.id, externalUserId: widgetUsers.externalUserId })
    .from(widgetUsers)
    .where(and(
      inArray(widgetUsers.id, ids),
      eq(widgetUsers.projectId, projectId),
    ));
  const map = new Map<string, string>();
  for (const r of dbRows) map.set(r.id, r.externalUserId);
  return map;
}

function mapCommentToWidgetResponse(
  comment: CanonicalTaskComment,
  externalUserIdMap: Map<string, string>,
  currentWidgetUserId?: string,
) {
  const externalUserId = comment.createdByType === 'external' && comment.createdById
    ? externalUserIdMap.get(comment.createdById) ?? null
    : null;
  const isAuthorOfCurrentUser = !!currentWidgetUserId
    && comment.createdByType === 'external'
    && comment.createdById === currentWidgetUserId;
  return {
    id: comment.id,
    body: comment.content,
    authorName: comment.createdByName ?? null,
    createdByType: comment.createdByType,
    externalUserId,
    isAuthorOfCurrentUser,
    canEdit: isAuthorOfCurrentUser,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    attachments: (comment.attachments ?? []).map(mapAttachmentSummary),
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
      isNull(workspaceTasks.deletedAt),
      ...(project.channelId ? [eq(workspaceTasks.workspaceChannelId, project.channelId)] : []),
    ))
    .limit(1);

  if (!task) return null;

  const isCreator = !!widgetUserId && task.createdByType === 'external' && task.createdById === widgetUserId;

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
    && comments.length === 0
    && activity.length === 0;

  // Look up the most recent agent_assigned activity for this ticket
  const lastAssignment = await db
    .select()
    .from(workspaceTaskActivity)
    .where(and(
      eq(workspaceTaskActivity.taskId, ticketId),
      eq(workspaceTaskActivity.type, 'agent_assigned'),
    ))
    .orderBy(desc(workspaceTaskActivity.createdAt))
    .limit(1);
  const lastAssign = lastAssignment[0];

  const externalUserIdMap = await resolveExternalUserIds(project.id, [
    ...comments,
    { createdByType: task.createdByType, createdById: task.createdById },
  ]);
  const mappedComments = comments.map(c => mapCommentToWidgetResponse(c, externalUserIdMap, widgetUserId));
  const ticketExternalUserId =
    task.createdByType === 'external' && task.createdById
      ? externalUserIdMap.get(task.createdById) ?? null
      : null;

  // Fetch the most recent clarification for this ticket and conditionally
  // expose open questions to the answerer (the assigner who initiated the
  // clarification session).  Non-owners and non-answerers get status+round but
  // an empty openQuestions array so question cards are never leaked.
  const clar = await ClarifierService.getTicketClarification(task.id);
  let clarification: PublicTicketDetail['clarification'] = null;
  if (clar !== null) {
    const isAnswerer = !!widgetUserId && widgetUserId === clar.widgetUserId;
    const openQuestions =
      isAnswerer && clar.status === 'asking'
        ? await ClarifierService.listOpenQuestions(clar.id)
        : [];
    clarification = {
      id: clar.id,
      status: clar.status,
      round: clar.round,
      openQuestions,
      duplicateOf: clar.duplicateOfTaskId ?? null,
    };
  }

  // Derive the most recent linked PR from the already-loaded activity feed.
  // Reuses the feed — no extra DB query needed.
  const linkedPr = deriveLinkedPr(activity);

  return {
    ticket: {
      ...mapTaskToWidgetResponse(task),
      attachments: (fullTask?.attachments ?? []).map(mapAttachmentSummary),
      createdByType: task.createdByType,
      externalUserId: ticketExternalUserId,
      commentsDisabled: task.commentsDisabled,
      assignedAgentName: lastAssign?.metadata && (lastAssign.metadata as any).agentName
        ? String((lastAssign.metadata as any).agentName)
        : null,
      lastTriager: lastAssign?.createdByType === 'external'
        ? { name: lastAssign.createdByName ?? null, at: lastAssign.createdAt.toISOString() }
        : null,
    },
    isOwner,
    isEditable,
    comments: mappedComments,
    activity: activity.map((entry) => ({
      id: entry.id,
      type: entry.type,
      content: entry.content ?? null,
      createdByName: entry.createdByName ?? null,
      createdAt: entry.createdAt,
      metadata: entry.metadata ?? null,
      attachments: (entry.attachments ?? []).map(mapAttachmentSummary),
    })),
    clarification,
    linkedPr,
  };
}

async function resolveTicketVisibleToWidget(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
): Promise<{ serverId: string; commentsDisabled: boolean } | null> {
  const project = await getWidgetProjectContext(projectId);
  if (!project) return null;

  const [task] = await db
    .select({
      id: workspaceTasks.id,
      serverId: workspaceTasks.serverId,
      visibility: workspaceTasks.visibility,
      moderationStatus: workspaceTasks.moderationStatus,
      createdByType: workspaceTasks.createdByType,
      createdById: workspaceTasks.createdById,
      workspaceChannelId: workspaceTasks.workspaceChannelId,
      commentsDisabled: workspaceTasks.commentsDisabled,
    })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
      isNull(workspaceTasks.deletedAt),
      ...(project.channelId ? [eq(workspaceTasks.workspaceChannelId, project.channelId)] : []),
    ))
    .limit(1);

  if (!task) return null;

  const isOwner = task.createdByType === 'external' && task.createdById === widgetUserId;

  // Public → anyone identified can comment.
  if (task.visibility === 'public') {
    return { serverId: task.serverId, commentsDisabled: task.commentsDisabled };
  }

  // Private → owner only.
  if (isOwner) {
    return { serverId: task.serverId, commentsDisabled: task.commentsDisabled };
  }

  return null;
}

export async function addWidgetComment(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
  content: string,
) {
  const visible = await resolveTicketVisibleToWidget(projectId, ticketId, widgetUserId);
  if (!visible) throw new WidgetError('ticket_not_found', 404);
  if (visible.commentsDisabled) throw new WidgetError('comments_disabled', 403);

  const [widgetUser] = await db
    .select({ name: widgetUsers.name })
    .from(widgetUsers)
    .where(eq(widgetUsers.id, widgetUserId))
    .limit(1);

  const comment = await WorkspaceTaskService.addComment(visible.serverId, ticketId, {
    content,
    createdByType: 'external',
    createdById: widgetUserId,
    createdByName: widgetUser?.name ?? null,
  });

  const externalUserIdMap = await resolveExternalUserIds(projectId, [comment]);
  return mapCommentToWidgetResponse(comment, externalUserIdMap, widgetUserId);
}

async function loadAndAuthorizeWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
): Promise<{ serverId: string }> {
  const visible = await resolveTicketVisibleToWidget(projectId, ticketId, widgetUserId);
  if (!visible) throw new WidgetError('ticket_not_found', 404);
  const [row] = await db
    .select({
      id: workspaceTaskComments.id,
      createdByType: workspaceTaskComments.createdByType,
      createdById: workspaceTaskComments.createdById,
      deletedAt: workspaceTaskComments.deletedAt,
    })
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.id, commentId),
      eq(workspaceTaskComments.taskId, ticketId),
    ))
    .limit(1);
  if (!row || row.deletedAt) throw new WidgetError('comment_not_found', 404);
  if (row.createdByType !== 'external' || row.createdById !== widgetUserId) {
    throw new WidgetError('comment_author_only', 403);
  }
  return { serverId: visible.serverId };
}

export async function updateWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
  content: string,
) {
  const { serverId } = await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);
  const updated = await WorkspaceTaskService.updateComment(serverId, ticketId, commentId, { content });
  if (!updated) throw new WidgetError('comment_not_found', 404);
  const externalUserIdMap = await resolveExternalUserIds(projectId, [updated]);
  return mapCommentToWidgetResponse(updated, externalUserIdMap, widgetUserId);
}

export async function deleteWidgetComment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
) {
  await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);
  await db
    .update(workspaceTaskComments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceTaskComments.id, commentId));
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

  if (!project) throw new WidgetError('project_not_found', 404);

  let title = opts.title?.trim() || '';
  if (!title && opts.description) {
    title = await generateTitle(opts.description);
  }
  if (!title) title = 'Untitled';

  // Moderation gating was removed — every new ticket is immediately
  // visible. Workflow status (pending/planned/in_progress) is the only
  // triage axis now.
  const moderationStatus = 'approved';

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
      // Published by default (single source of truth: resolveCreateIsPublished).
      // The published "Latest Updates" feed also gates on visibility='public',
      // so a ticket submitted as private stays hidden from others. Admins can
      // still unpublish later via PATCH /todos/:id.
      isPublished: WorkspaceTaskService.resolveCreateIsPublished({ sourceType: 'widget' }),
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
async function requireEditableTask(
  taskId: string,
  serverId: string,
  widgetUserId: string,
  opts: { skipPostActivityChecks?: boolean } = {},
) {
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, taskId),
      eq(workspaceTasks.serverId, serverId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new WidgetError('ticket_not_found', 404);
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new WidgetError('ticket_owner_only', 403);
  }
  // Visibility flips are exempt from the post-activity gate — toggling
  // private/public is a personal disclosure choice the owner should
  // retain regardless of triage state or comment count.
  if (opts.skipPostActivityChecks) return;

  if (task.status !== 'pending') throw new WidgetError('ticket_no_longer_editable', 409);

  const [commentCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskComments)
    .where(and(
      eq(workspaceTaskComments.taskId, taskId),
      isNull(workspaceTaskComments.deletedAt),
    ));
  if (Number(commentCount.count) > 0) throw new WidgetError('ticket_has_comments', 409);

  const [activityCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskActivity)
    .where(eq(workspaceTaskActivity.taskId, taskId));
  if (Number(activityCount.count) > 0) throw new WidgetError('ticket_has_activity', 409);

  return task;
}

export async function updateTicket(
  ticketId: string,
  projectId: string,
  widgetUserId: string,
  opts: { title?: string; description?: string; visibility?: 'public' | 'private' },
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new WidgetError('project_not_found', 404);

  // Visibility-only edits bypass the post-activity lockout so the owner
  // can flip private/public at any time. Title/description still require
  // an untouched ticket (no triage actions, no comments).
  const fields = Object.keys(opts).filter((k) => (opts as Record<string, unknown>)[k] !== undefined);
  const visibilityOnly = fields.length > 0 && fields.every((k) => k === 'visibility');
  await requireEditableTask(ticketId, project.serverId, widgetUserId, {
    skipPostActivityChecks: visibilityOnly,
  });

  const updates: Partial<typeof workspaceTasks.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (opts.title !== undefined) updates.title = opts.title.trim() || 'Untitled';
  if (opts.description !== undefined) updates.description = opts.description;
  if (opts.visibility !== undefined) {
    if (opts.visibility !== 'public' && opts.visibility !== 'private') {
      throw new WidgetError('invalid_visibility', 400);
    }
    updates.visibility = opts.visibility;
  }

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
  if (!project) throw new WidgetError('project_not_found', 404);

  await requireEditableTask(ticketId, project.serverId, widgetUserId);

  // Soft delete to be consistent with workspace task patterns
  await db
    .update(workspaceTasks)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceTasks.id, ticketId));
}

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ATTACHMENTS_PER_TICKET = 5;
// SVG is intentionally excluded: SVG is XML and can carry inline <script>,
// which becomes stored XSS if the asset is ever opened directly or rendered
// via <object>/<iframe>. Re-enabling requires server-side sanitization.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export async function uploadTicketAttachment(
  ticketId: string,
  projectId: string,
  widgetUserId: string,
  file: { buffer: Buffer; mimeType: string; filename: string; originalName?: string },
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new WidgetError('project_not_found', 404);

  if (!attachmentStorage.isConfigured()) {
    throw new WidgetError('attachment_storage_unconfigured', 500);
  }

  // Validate image type
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimeType)) {
    throw new WidgetError('attachment_unsupported_type', 400);
  }

  // Validate file size
  if (file.buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new WidgetError('attachment_too_large', 413);
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

  if (!task) throw new WidgetError('ticket_not_found', 404);
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new WidgetError('ticket_owner_only', 403);
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
    throw new WidgetError('attachment_count_exceeded', 400);
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

const MAX_ATTACHMENTS_PER_COMMENT = 5;

export async function addWidgetCommentAttachment(
  projectId: string,
  ticketId: string,
  commentId: string,
  widgetUserId: string,
  file: { buffer: Buffer; mimeType: string; filename: string; originalName?: string },
) {
  const { serverId } = await loadAndAuthorizeWidgetComment(projectId, ticketId, commentId, widgetUserId);

  if (!ALLOWED_IMAGE_TYPES.includes(file.mimeType)) {
    throw new WidgetError('attachment_unsupported_type', 400);
  }
  if (file.buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new WidgetError('attachment_too_large', 413);
  }
  if (!attachmentStorage.isConfigured()) {
    throw new WidgetError('attachment_storage_unconfigured', 500);
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceTaskAttachments)
    .where(and(
      eq(workspaceTaskAttachments.ownerType, 'comment'),
      eq(workspaceTaskAttachments.ownerId, commentId),
    ));
  if (Number(countRow.count) >= MAX_ATTACHMENTS_PER_COMMENT) {
    throw new WidgetError('attachment_count_exceeded', 400);
  }

  const stored = await attachmentStorage.storeUpload({
    serverId,
    body: file.buffer,
    mimeType: file.mimeType,
    filename: file.filename,
    originalName: file.originalName ?? file.filename,
    ownerType: 'comment',
  });

  const [attachment] = await db
    .insert(workspaceTaskAttachments)
    .values({
      serverId,
      taskId: ticketId,
      ownerType: 'comment',
      ownerId: commentId,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      mimeType: stored.mimeType,
      originalName: stored.originalName ?? null,
    })
    .returning();

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
  if (!project) throw new WidgetError('project_not_found', 404);

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

  if (!task) throw new WidgetError('ticket_not_found', 404);
  if (task.createdByType !== 'external' || task.createdById !== widgetUserId) {
    throw new WidgetError('ticket_owner_only', 403);
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

  if (!attachment) throw new WidgetError('attachment_not_found', 404);

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
    isNull(workspaceTasks.deletedAt),
    ...(channelCondition ? [channelCondition] : []),
  ];

  const [result] = await db
    .select({
      totalOpen: sql<number>`count(*) filter (where ${workspaceTasks.status} not in ('done', 'deployed', 'cancelled'))`,
      totalDone: sql<number>`count(*) filter (where ${workspaceTasks.status} in ('done', 'deployed'))`,
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
        sql`${workspaceTasks.status} in ('done', 'deployed')`,
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
  projectId: string,
  ticketId: string,
  widgetUserId: string,
  value: boolean
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new WidgetError('project_not_found', 404);

  const [task] = await db
    .select({
      id: workspaceTasks.id,
      serverId: workspaceTasks.serverId,
      votingEndsAt: workspaceTasks.votingEndsAt,
    })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
      isNull(workspaceTasks.deletedAt),
    ))
    .limit(1);

  if (!task) throw new WidgetError('ticket_not_found', 404);
  if (task.votingEndsAt && new Date() > task.votingEndsAt) {
    throw new WidgetError('voting_period_ended', 400);
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

export async function retractVote(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
) {
  const project = await getWidgetProjectContext(projectId);
  if (!project) throw new WidgetError('project_not_found', 404);

  const [task] = await db
    .select({ serverId: workspaceTasks.serverId })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.serverId, project.serverId),
    ))
    .limit(1);

  if (!task) throw new WidgetError('ticket_not_found', 404);

  await db
    .delete(workspaceTaskVotes)
    .where(
      and(
        eq(workspaceTaskVotes.taskId, ticketId),
        eq(workspaceTaskVotes.voterId, widgetUserId),
      )
    );

  await recountVotes(ticketId, task.serverId);
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
  opts: { name: string; channelId: string; workspaceProjectId: string }
) {
  if (!opts.workspaceProjectId) {
    throw new Error('enableWidget: workspaceProjectId is required');
  }
  if (!opts.channelId) {
    throw new Error('enableWidget: channelId is required');
  }

  // Re-enable case: a widget already exists for this (server, project) pair.
  // Reusing the slug preserves the public project-page URL across re-enables.
  const [existing] = await db
    .select({ slug: widgetProjects.slug })
    .from(widgetProjects)
    .where(and(
      eq(widgetProjects.serverId, serverId),
      eq(widgetProjects.workspaceProjectId, opts.workspaceProjectId),
    ))
    .limit(1);

  const apiSecret = randomBytes(32).toString('base64url');
  const apiKey = deriveFingerprint(apiSecret);
  const slugSuffix = randomBytes(4).toString('hex');
  const slug = existing?.slug ?? generateSlug(opts.name, slugSuffix);

  const [project] = await db
    .insert(widgetProjects)
    .values({
      serverId,
      workspaceProjectId: opts.workspaceProjectId,
      name: opts.name,
      slug,
      apiKey,
      apiSecretHash: apiSecret,
      enabled: true,
      channelId: opts.channelId,
    })
    .onConflictDoUpdate({
      // Matches the partial unique index widget_projects_server_workspace_project_unique.
      target: [widgetProjects.serverId, widgetProjects.workspaceProjectId],
      targetWhere: isNotNull(widgetProjects.workspaceProjectId),
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

export async function disableWidget(serverId: string, lookup?: WidgetLookup) {
  const conditions: ReturnType<typeof eq>[] = [eq(widgetProjects.serverId, serverId)];
  const extra = widgetLookupCondition(lookup);
  if (extra) conditions.push(extra);
  await db
    .update(widgetProjects)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(...conditions));
}

export async function regenerateSecret(serverId: string, lookup?: WidgetLookup) {
  const newSecret = randomBytes(32).toString('base64url');
  const newFingerprint = deriveFingerprint(newSecret);
  const conditions: ReturnType<typeof eq>[] = [eq(widgetProjects.serverId, serverId)];
  const extra = widgetLookupCondition(lookup);
  if (extra) conditions.push(extra);
  const [project] = await db
    .update(widgetProjects)
    .set({ apiSecretHash: newSecret, apiKey: newFingerprint, updatedAt: new Date() })
    .where(and(...conditions))
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
 * Sign a widget_user JWT. Pure function — takes all signing material as params
 * so it's testable without DB access.
 */
export async function signWidgetUserJwt(params: {
  apiSecretHash: string;
  apiKey: string;
  userId: string;
  userName?: string;
  /**
   * Role claim to embed, using the project's configured claim name —
   * exactly the shape derivePermissions reads at auth time. Set by the
   * BE's own mint paths (dogfood feedback embed, preview auto-inject)
   * after verifying the user is an owner/admin of the widget's workspace.
   */
  roleClaim?: { name: string; roles: string[] };
}): Promise<string> {
  const signingKey = new TextEncoder().encode(params.apiSecretHash);
  return await new jose.SignJWT({
    // Role claim is spread FIRST so a claim name colliding with a reserved
    // claim (fp/type/name — and sub/iat/exp via the setters below) can
    // never clobber it: the reserved value always wins.
    ...(params.roleClaim ? { [params.roleClaim.name]: params.roleClaim.roles } : {}),
    fp: params.apiKey,
    type: 'widget_user',
    ...(params.userName ? { name: params.userName } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime(WIDGET_JWT_MAX_TOKEN_AGE)
    .sign(signingKey);
}

/**
 * Mint-time role resolution for BE-issued widget tokens.
 *
 * The widget key (`fp`) identifies the project, the project identifies the
 * workspace (`server_id`). When the authenticated RunHQ user is an
 * owner/admin of that workspace and the project has triager assignment
 * enabled, return the project's configured role claim — the exact shape
 * derivePermissions reads at auth time, so the minted token grants
 * assign_agent through the same single code path customer JWTs use.
 *
 * Returns undefined otherwise: the token mints with no role claim and the
 * viewer is a regular identified widget user.
 */
async function workspaceRoleClaimFor(
  project: {
    serverId: string;
    widgetAgentAssignmentEnabled: boolean;
    widgetAssignRoles: string[];
    widgetRoleClaimName: string;
  },
  userId: string,
): Promise<{ name: string; roles: string[] } | undefined> {
  if (!project.widgetAgentAssignmentEnabled) return undefined;
  if (project.widgetAssignRoles.length === 0) return undefined;
  const membership = await getServerMembership(project.serverId, userId);
  if (!membership || !isOwnerOrAdmin(membership)) return undefined;
  return { name: project.widgetRoleClaimName, roles: project.widgetAssignRoles };
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
      serverId: widgetProjects.serverId,
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      widgetAssignRoles: widgetProjects.widgetAssignRoles,
      widgetRoleClaimName: widgetProjects.widgetRoleClaimName,
    })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.apiKey, fingerprint), eq(widgetProjects.enabled, true)))
    .limit(1);

  if (!project) return null;

  const token = await signWidgetUserJwt({
    apiSecretHash: project.apiSecretHash,
    apiKey: project.apiKey,
    userId,
    userName,
    // userId is console-verified — workspace owners/admins get the project's
    // triager role claim baked in at mint time.
    roleClaim: await workspaceRoleClaimFor(project, userId),
  });

  return { token };
}

export async function getWidgetIntegration(serverId: string, lookup?: WidgetLookup) {
  const conditions = [
    eq(widgetProjects.serverId, serverId),
    eq(widgetProjects.enabled, true),
  ];
  const extra = widgetLookupCondition(lookup);
  if (extra) conditions.push(extra);
  const [project] = await db
    .select()
    .from(widgetProjects)
    .where(and(...conditions))
    .limit(1);

  return project ?? null;
}

// ============================================================================
// Preview auto-injection
// ============================================================================

export interface PreviewWidgetBootstrap {
  widgetToken: string;
  config: {
    projectSlug: string;
    widgetPosition: string | null;
    channelId: string;
    autoApprove: boolean;
  };
}

/**
 * Mint a widget_user JWT + config for the preview auto-inject flow.
 *
 * Returns null when the server has no widget project, widget is disabled,
 * auto-inject is not enabled, or no channel is configured. Callers should
 * map null to 404.
 */
export async function generatePreviewWidgetBootstrap(
  serverId: string,
  userId: string,
  userName?: string,
  workspaceProjectId?: string,
): Promise<PreviewWidgetBootstrap | null> {
  const conditions = [eq(widgetProjects.serverId, serverId)];
  if (workspaceProjectId) {
    conditions.push(eq(widgetProjects.workspaceProjectId, workspaceProjectId));
  }
  const [project] = await db
    .select({
      slug: widgetProjects.slug,
      apiKey: widgetProjects.apiKey,
      apiSecretHash: widgetProjects.apiSecretHash,
      enabled: widgetProjects.enabled,
      autoInjectInPreview: widgetProjects.autoInjectInPreview,
      widgetPosition: widgetProjects.widgetPosition,
      channelId: widgetProjects.channelId,
      autoApprove: widgetProjects.autoApprove,
      serverId: widgetProjects.serverId,
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      widgetAssignRoles: widgetProjects.widgetAssignRoles,
      widgetRoleClaimName: widgetProjects.widgetRoleClaimName,
    })
    .from(widgetProjects)
    .where(and(...conditions))
    .limit(1);

  if (!project || !project.enabled || !project.autoInjectInPreview || !project.channelId) {
    return null;
  }

  const widgetToken = await signWidgetUserJwt({
    apiSecretHash: project.apiSecretHash,
    apiKey: project.apiKey,
    userId,
    userName,
    // userId is workspace-verified — owners/admins get the project's
    // triager role claim baked in at mint time.
    roleClaim: await workspaceRoleClaimFor(project, userId),
  });

  return {
    widgetToken,
    config: {
      projectSlug: project.slug,
      widgetPosition: project.widgetPosition,
      channelId: project.channelId,
      autoApprove: project.autoApprove,
    },
  };
}

/**
 * Report whether a server has auto-inject enabled (used by the preview proxy
 * to decide whether to include the bootstrap script in HTML responses).
 *
 * Keying: this is the workspace→BE preview path; the workspace preview proxy
 * sends `?projectId=` (workspaceProjectId). The parameter mirrors
 * `generatePreviewWidgetBootstrap` and is intentionally NOT a `WidgetLookup`
 * — Phase 5 removed channel/project unification from that type, but this
 * call site still legitimately keys by workspace project. When omitted, the
 * function returns the server's first matching auto-inject row (legacy
 * behavior preserved for callers that don't supply a project id).
 */
export async function getPreviewWidgetFlag(
  serverId: string,
  workspaceProjectId?: string,
): Promise<{
  shouldInject: boolean;
  projectSlug?: string;
}> {
  const conditions = [eq(widgetProjects.serverId, serverId)];
  if (workspaceProjectId) {
    conditions.push(eq(widgetProjects.workspaceProjectId, workspaceProjectId));
  }
  const [project] = await db
    .select({
      slug: widgetProjects.slug,
      enabled: widgetProjects.enabled,
      autoInjectInPreview: widgetProjects.autoInjectInPreview,
      channelId: widgetProjects.channelId,
    })
    .from(widgetProjects)
    .where(and(...conditions))
    .limit(1);

  if (!project || !project.enabled || !project.autoInjectInPreview || !project.channelId) {
    return { shouldInject: false };
  }

  return { shouldInject: true, projectSlug: project.slug };
}

export async function getWidgetSettings(serverId: string, lookup?: WidgetLookup) {
  const conditions = [eq(widgetProjects.serverId, serverId)];
  const extra = widgetLookupCondition(lookup);
  if (extra) conditions.push(extra);
  const [project] = await db
    .select({
      autoApprove: widgetProjects.autoApprove,
      widgetPosition: widgetProjects.widgetPosition,
      widgetLanguage: widgetProjects.widgetLanguage,
      votingPeriodHours: widgetProjects.votingPeriodHours,
      isPublic: widgetProjects.isPublic,
      widgetLoginUrl: widgetProjects.widgetLoginUrl,
      allowedOrigins: widgetProjects.allowedOrigins,
      autoRecognizeRunhqMembers: widgetProjects.autoRecognizeRunhqMembers,
      autoInjectInPreview: widgetProjects.autoInjectInPreview,
      channelId: widgetProjects.channelId,
      slug: widgetProjects.slug,
      widgetAgentAssignmentEnabled: widgetProjects.widgetAgentAssignmentEnabled,
      widgetAssignRoles: widgetProjects.widgetAssignRoles,
      widgetRoleClaimName: widgetProjects.widgetRoleClaimName,
      widgetAssignRateLimitPerHour: widgetProjects.widgetAssignRateLimitPerHour,
      widgetChatAgentEntityId: widgetProjects.widgetChatAgentEntityId,
      widgetChatInstructions: widgetProjects.widgetChatInstructions,
    })
    .from(widgetProjects)
    .where(and(...conditions))
    .limit(1);

  if (!project) return null;

  return {
    auto_approve: project.autoApprove,
    widget_position: project.widgetPosition,
    widget_language: project.widgetLanguage,
    voting_period_hours: project.votingPeriodHours,
    is_public: project.isPublic,
    login_url: project.widgetLoginUrl,
    allowed_origins: project.allowedOrigins,
    auto_recognize_runhq_members: project.autoRecognizeRunhqMembers,
    auto_inject_in_preview: project.autoInjectInPreview,
    channel_id: project.channelId,
    slug: project.slug,
    widget_agent_assignment_enabled: project.widgetAgentAssignmentEnabled,
    widget_assign_roles: project.widgetAssignRoles,
    widget_role_claim_name: project.widgetRoleClaimName,
    widget_assign_rate_limit_per_hour: project.widgetAssignRateLimitPerHour,
    widgetChatAgentEntityId: project.widgetChatAgentEntityId,
    widgetChatInstructions: project.widgetChatInstructions,
  };
}

export class WidgetSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetSettingsValidationError';
  }
}

/**
 * Result flags the caller needs for side-effects that live outside the service
 * (push-invalidate the preview proxy when auto-inject changed).
 */
export interface UpdateWidgetSettingsResult {
  autoInjectChanged: boolean;
}

export async function updateWidgetSettings(
  serverId: string,
  settings: {
    auto_approve?: boolean;
    widget_position?: string;
    widget_language?: string | null;
    voting_period_hours?: number;
    is_public?: boolean;
    login_url?: string | null;
    allowed_origins?: string[];
    auto_recognize_runhq_members?: boolean;
    auto_inject_in_preview?: boolean;
    slug?: string;
    /** Target todo channel the widget feeds. Re-targets the widget when changed. */
    channelId?: string;
    // Triager assignment policy fields
    widgetAgentAssignmentEnabled?: boolean;
    widgetAssignRoles?: string[];
    widgetRoleClaimName?: string;
    widgetAssignRateLimitPerHour?: number;
    // Chat-with-agent intake (camelCase per the widget-chat contract)
    widgetChatAgentEntityId?: string | null;
    widgetChatInstructions?: string | null;
  },
  opts?: WidgetLookup,
): Promise<UpdateWidgetSettingsResult> {
  // Lookup key comes exclusively from `opts` — the second argument.
  // Phase 5: channelId-only. The legacy positional-string and
  // `workspaceProjectId` lookup forms have been removed.
  const key = opts;

  // Empty-roles guard: enabling assignment without roles is a configuration error.
  if (settings.widgetAgentAssignmentEnabled === true) {
    if (!settings.widgetAssignRoles || settings.widgetAssignRoles.length === 0) {
      throw new WidgetSettingsValidationError(
        'Cannot enable widget agent assignment: add at least one role.',
      );
    }
  }

  // Chat instructions are an instruction layer injected into agent turns —
  // cap their size like a chat message.
  if (
    settings.widgetChatInstructions !== undefined &&
    settings.widgetChatInstructions !== null &&
    settings.widgetChatInstructions.length > 4000
  ) {
    throw new WidgetSettingsValidationError('Chat instructions must be 4000 characters or fewer.');
  }

  // Validate login_url shape on every update that touches it. The
  // "required when public" check happens after we read existing state below.
  if (settings.login_url !== undefined && settings.login_url !== null && settings.login_url !== '') {
    if (!isSafeHttpUrl(settings.login_url)) {
      throw new WidgetSettingsValidationError(
        'Login URL must be a valid http:// or https:// URL.',
      );
    }
  }

  // Validate + normalize allowed_origins. Each entry must parse as
  // http(s) URL; otherwise reject with a per-entry message. After
  // normalization, duplicates collapse — two entries that differ only
  // in trailing slash or default port resolve to the same origin.
  let normalizedOrigins: string[] | undefined;
  if (settings.allowed_origins !== undefined) {
    if (!Array.isArray(settings.allowed_origins)) {
      throw new WidgetSettingsValidationError('allowed_origins must be an array.');
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of settings.allowed_origins) {
      const normalized = normalizeOrigin(raw);
      if (!normalized) {
        throw new WidgetSettingsValidationError(
          `Invalid origin "${raw}". Origins must be http(s) URLs (e.g. https://acme.com).`,
        );
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    normalizedOrigins = out;
  }

  // Build a reusable conditions array for all three internal queries.
  const projConds = (): ReturnType<typeof eq>[] => {
    const c: ReturnType<typeof eq>[] = [eq(widgetProjects.serverId, serverId)];
    const extra = widgetLookupCondition(key);
    if (extra) c.push(extra);
    return c;
  };

  // Enabling auto-inject requires a channel already to be set on the project.
  // Without a channel the widget has nowhere to submit tickets.
  if (settings.auto_inject_in_preview === true) {
    const [current] = await db
      .select({ channelId: widgetProjects.channelId })
      .from(widgetProjects)
      .where(and(...projConds()))
      .limit(1);
    if (!current?.channelId) {
      throw new WidgetSettingsValidationError(
        'Set a channel on the widget project before enabling auto-inject in preview URLs.',
      );
    }
  }

  // Required-when-public guard for login_url. We need to know the *resulting*
  // state after this update is applied: if the row would end up with
  // is_public=true but no login_url, reject. This blocks both
  //   (a) flipping is_public on without supplying a URL when none is stored, and
  //   (b) clearing login_url while is_public is already true.
  if (settings.is_public === true || settings.login_url === '' || settings.login_url === null) {
    const [current] = await db
      .select({
        isPublic: widgetProjects.isPublic,
        widgetLoginUrl: widgetProjects.widgetLoginUrl,
      })
      .from(widgetProjects)
      .where(and(...projConds()))
      .limit(1);

    const finalIsPublic =
      settings.is_public !== undefined ? settings.is_public : !!current?.isPublic;
    const finalLoginUrl =
      settings.login_url !== undefined
        ? (settings.login_url ?? '').trim()
        : (current?.widgetLoginUrl ?? '').trim();

    if (finalIsPublic && !finalLoginUrl) {
      throw new WidgetSettingsValidationError(
        'A Login URL is required when the project is public.',
      );
    }
  }

  // Required-when-auto-recognize guard for allowed_origins. Mirrors the
  // login-URL pattern: the resulting state must have at least one origin
  // when auto-recognize is on. Blocks both
  //   (a) flipping auto-recognize on without supplying origins, and
  //   (b) clearing origins while auto-recognize is already on.
  if (
    settings.auto_recognize_runhq_members === true ||
    (normalizedOrigins !== undefined && normalizedOrigins.length === 0)
  ) {
    const [current] = await db
      .select({
        autoRecognizeRunhqMembers: widgetProjects.autoRecognizeRunhqMembers,
        allowedOrigins: widgetProjects.allowedOrigins,
      })
      .from(widgetProjects)
      .where(and(...projConds()))
      .limit(1);

    const finalAutoRecognize =
      settings.auto_recognize_runhq_members !== undefined
        ? settings.auto_recognize_runhq_members
        : !!current?.autoRecognizeRunhqMembers;
    const finalOrigins =
      normalizedOrigins !== undefined ? normalizedOrigins : (current?.allowedOrigins ?? []);

    if (finalAutoRecognize && finalOrigins.length === 0) {
      throw new WidgetSettingsValidationError(
        'Add at least one allowed origin before enabling RunHQ-member auto-recognition.',
      );
    }
  }

  // Detect whether auto-inject flipped so the caller can push-invalidate.
  let autoInjectChanged = false;
  if (settings.auto_inject_in_preview !== undefined) {
    const [current] = await db
      .select({ autoInjectInPreview: widgetProjects.autoInjectInPreview })
      .from(widgetProjects)
      .where(and(...projConds()))
      .limit(1);
    if (current && current.autoInjectInPreview !== settings.auto_inject_in_preview) {
      autoInjectChanged = true;
    }
  }

  await db
    .update(widgetProjects)
    .set({
      ...(settings.auto_approve !== undefined && { autoApprove: settings.auto_approve }),
      ...(settings.widget_position !== undefined && { widgetPosition: settings.widget_position }),
      ...(settings.widget_language !== undefined && { widgetLanguage: settings.widget_language }),
      ...(settings.voting_period_hours !== undefined && { votingPeriodHours: settings.voting_period_hours }),
      ...(settings.is_public !== undefined && { isPublic: settings.is_public }),
      // Empty string is normalized to null so the DB has a single
      // representation for "no login URL set".
      ...(settings.login_url !== undefined && {
        widgetLoginUrl: settings.login_url && settings.login_url.trim() ? settings.login_url.trim() : null,
      }),
      ...(normalizedOrigins !== undefined && { allowedOrigins: normalizedOrigins }),
      ...(settings.auto_recognize_runhq_members !== undefined && {
        autoRecognizeRunhqMembers: settings.auto_recognize_runhq_members,
      }),
      ...(settings.auto_inject_in_preview !== undefined && { autoInjectInPreview: settings.auto_inject_in_preview }),
      ...(settings.slug !== undefined && { slug: settings.slug }),
      // Re-target: only set when a non-empty channel is supplied (channel_id is
      // NOT NULL in the DB, so never write an empty/null target).
      ...(settings.channelId !== undefined && settings.channelId !== '' && { channelId: settings.channelId }),
      // Triager assignment policy — only set when caller explicitly provides the field
      ...(settings.widgetAgentAssignmentEnabled !== undefined && { widgetAgentAssignmentEnabled: settings.widgetAgentAssignmentEnabled }),
      ...(settings.widgetAssignRoles !== undefined && { widgetAssignRoles: settings.widgetAssignRoles }),
      ...(settings.widgetRoleClaimName !== undefined && { widgetRoleClaimName: settings.widgetRoleClaimName }),
      ...(settings.widgetAssignRateLimitPerHour !== undefined && { widgetAssignRateLimitPerHour: settings.widgetAssignRateLimitPerHour }),
      // Chat settings — empty string normalizes to null ("chat disabled" /
      // "no extra instructions" have a single representation).
      ...(settings.widgetChatAgentEntityId !== undefined && {
        widgetChatAgentEntityId: settings.widgetChatAgentEntityId?.trim()
          ? settings.widgetChatAgentEntityId.trim()
          : null,
      }),
      ...(settings.widgetChatInstructions !== undefined && {
        widgetChatInstructions: settings.widgetChatInstructions?.trim()
          ? settings.widgetChatInstructions.trim()
          : null,
      }),
      updatedAt: new Date(),
    })
    .where(and(...projConds()));

  return { autoInjectChanged };
}

// ============================================================================
// Title Generation
// ============================================================================

export interface ReconcileMaps {
  channelToProject: Record<string, string>;
  projectToPrimaryTodoChannel: Record<string, string>;
}

/**
 * Two-pass idempotent backfill for widget_projects rows missing one of the
 * two keys. Workspace POSTs both maps on each reconcile tick; we fill rows
 * in-place. Rows where the relevant map has no entry are left untouched
 * (e.g. the channel was deleted on the workspace).
 *
 * Rows with both `channel_id` and `workspace_project_id` NULL are
 * intentionally left untouched — they're pre-rollout orphans that the
 * Phase 4 migration surfaces for manual triage.
 */
export async function reconcileWidgetBindings(
  serverId: string,
  maps: ReconcileMaps,
): Promise<{ updated: number }> {
  let updated = 0;

  // Pass 1: backfill workspace_project_id where NULL but channel_id is set.
  const missingProject = await db
    .select({ id: widgetProjects.id, channelId: widgetProjects.channelId })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.serverId, serverId), isNull(widgetProjects.workspaceProjectId)));
  for (const row of missingProject) {
    if (!row.channelId) continue;
    const projId = maps.channelToProject[row.channelId];
    if (!projId) continue;
    await db.update(widgetProjects)
      .set({ workspaceProjectId: projId, updatedAt: new Date() })
      .where(eq(widgetProjects.id, row.id));
    updated++;
  }

  // Pass 2: backfill channel_id where NULL but workspace_project_id is set.
  const missingChannel = await db
    .select({ id: widgetProjects.id, workspaceProjectId: widgetProjects.workspaceProjectId })
    .from(widgetProjects)
    .where(and(eq(widgetProjects.serverId, serverId), isNull(widgetProjects.channelId)));
  for (const row of missingChannel) {
    if (!row.workspaceProjectId) continue;
    const chanId = maps.projectToPrimaryTodoChannel[row.workspaceProjectId];
    if (!chanId) continue;
    await db.update(widgetProjects)
      .set({ channelId: chanId, updatedAt: new Date() })
      .where(eq(widgetProjects.id, row.id));
    updated++;
  }

  return { updated };
}

/**
 * Sync workspace project metadata into widget_projects so widget UIs reflect
 * workspace renames. The workspace POSTs the full list of its projects on
 * every project change and on boot; BE updates `name` for each matching
 * (serverId, workspaceProjectId) row whose name has actually changed.
 *
 * Scoped per `serverId`: rows on other servers are not touched, even if a
 * workspace_project_id collides. Rows that have no `workspace_project_id`
 * are skipped (those are pre-rollout rows; `reconcileWidgetBindings`
 * handles backfilling them via channel mapping).
 *
 * Idempotent: re-sending the same payload is a no-op. The returned `updated`
 * count reflects actual writes — useful for lightweight telemetry.
 */
export async function syncProjectMetadata(
  serverId: string,
  projects: Array<{ id: string; name: string }>,
): Promise<{ updated: number }> {
  if (projects.length === 0) return { updated: 0 };

  const ids = projects.map((p) => p.id);
  const existing = await db
    .select({
      id: widgetProjects.id,
      workspaceProjectId: widgetProjects.workspaceProjectId,
      name: widgetProjects.name,
    })
    .from(widgetProjects)
    .where(and(
      eq(widgetProjects.serverId, serverId),
      inArray(widgetProjects.workspaceProjectId, ids),
    ));

  const desiredByWorkspaceProjectId = new Map(projects.map((p) => [p.id, p.name]));

  let updated = 0;
  for (const row of existing) {
    if (!row.workspaceProjectId) continue;
    const desired = desiredByWorkspaceProjectId.get(row.workspaceProjectId);
    if (desired === undefined) continue;
    if (desired === row.name) continue;
    await db.update(widgetProjects)
      .set({ name: desired, updatedAt: new Date() })
      .where(eq(widgetProjects.id, row.id));
    updated++;
  }
  return { updated };
}

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
      system:
        'You are a labeling function. Given a feature request or bug report, output a concise title (max 10 words). IMPORTANT: Output the title in the SAME LANGUAGE as the input — do NOT translate. Do NOT interpret the report, do NOT respond conversationally, do NOT add quotes or trailing punctuation. Just output the title.\n\nExamples:\nInput: "Users keep getting logged out after 30 minutes of inactivity"\nOutput: Session timeout logs users out too quickly\n\nInput: "로그인 페이지에서 비밀번호 재설정이 안 되는 버그를 수정해주세요"\nOutput: 로그인 페이지 비밀번호 재설정 버그',
      messages: [
        {
          role: 'user',
          content: `Input: "${description}"\nOutput:`,
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
// Exposed Agents
// ============================================================================

export interface ExposedAgentSummary {
  id: string;
  name: string;
  description: string | null;
}

export async function listExposedAgents(widgetProjectId: string): Promise<ExposedAgentSummary[]> {
  return await db
    .select({
      id: widgetExposedAgents.agentId,
      name: widgetExposedAgents.agentName,
      description: widgetExposedAgents.agentDescription,
    })
    .from(widgetExposedAgents)
    .where(eq(widgetExposedAgents.widgetProjectId, widgetProjectId))
    .orderBy(widgetExposedAgents.agentName);
}

// ============================================================================
// Agent Assignment
// ============================================================================

export interface AssignAgentRequest {
  agentId: string;
  command: string;
  actor: {
    widgetUserId: string;
    externalUserId: string;
    name: string | null;
    matchedRoles: string[];
  };
  /** Clarification Q&A to seed the workspace coder with context. Absent when the ticket needed no clarification. */
  qa?: Array<{ question: string; answer: string }>;
}

export interface AssignAgentResult {
  jobId: string;
}

export class WidgetAssignError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(code);
    this.name = 'WidgetAssignError';
  }
}

/**
 * Stable error codes for the public widget API.
 *
 * Adding `as const` makes the codes a closed set so that route handlers
 * can exhaustively map `.code` → HTTP status without catching arbitrary
 * Error.message strings (which would risk leaking DB / driver internals
 * to unauthenticated callers).
 */
export const WIDGET_ERROR_CODES = [
  'project_not_found',
  'ticket_not_found',
  'comment_not_found',
  'attachment_not_found',
  'ticket_owner_only',
  'comment_author_only',
  'comments_disabled',
  'ticket_no_longer_editable',
  'ticket_has_comments',
  'ticket_has_activity',
  'invalid_visibility',
  'voting_period_ended',
  'attachment_unsupported_type',
  'attachment_too_large',
  'attachment_count_exceeded',
  'attachment_storage_unconfigured',
  'rate_limited',
  // Widget chat (agent intake)
  'chat_not_enabled',
  'conversation_not_found',
  'conversation_closed',
  'message_required',
  'message_too_long',
  'turn_limit_reached',
  'invalid_cursor',
  'no_pending_proposal',
  'invalid_proposal_draft',
] as const;

export type WidgetErrorCode = typeof WIDGET_ERROR_CODES[number];

/**
 * Service-layer error thrown by the public widget API. Routes map `.code`
 * + `.status` to the response body; anything else that escapes is logged
 * and reported as `{error: 'internal'}` to avoid leaking DB internals.
 */
export class WidgetError extends Error {
  constructor(
    public readonly code: WidgetErrorCode,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(code);
    this.name = 'WidgetError';
  }
}

/**
 * Forwards an authorized triager assignment to the workspace and records
 * an activity entry. Caller MUST have already passed:
 *   - JWT auth + assign_agent permission
 *   - Agent exposure check
 *   - Rate-limit check
 */
/** Fetch the rate-limit quota for a widget project (returns default 30 if not found). */
export async function getWidgetProjectRateLimit(projectId: string): Promise<number> {
  const [proj] = await db
    .select({ limit: widgetProjects.widgetAssignRateLimitPerHour })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);
  return proj?.limit ?? 30;
}

/** Fetch the external user details for audit attribution. */
export async function getWidgetUserAuditInfo(
  widgetUserId: string,
): Promise<{ externalUserId: string; name: string | null } | null> {
  const [wu] = await db
    .select({ externalUserId: widgetUsers.externalUserId, name: widgetUsers.name })
    .from(widgetUsers)
    .where(eq(widgetUsers.id, widgetUserId))
    .limit(1);
  return wu ?? null;
}

// ============================================================================
// Shared resolution helpers (used by getTicketForAssign and assignAgent)
// ============================================================================

/**
 * Resolve the serverId for a widget project.
 * Returns null when the project does not exist.
 */
async function resolveWidgetServerId(widgetProjectId: string): Promise<string | null> {
  const [proj] = await db
    .select({ serverId: widgetProjects.serverId })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, widgetProjectId))
    .limit(1);
  return proj?.serverId ?? null;
}

/**
 * Load the title and description for a widget-sourced task scoped to a server.
 * Returns null when no matching row exists (task missing, wrong server, wrong sourceType).
 */
async function getWidgetTaskRow(
  serverId: string,
  ticketId: string,
): Promise<{ title: string; description: string | null } | null> {
  const [task] = await db
    .select({ title: workspaceTasks.title, description: workspaceTasks.description })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.sourceType, 'widget'),
      eq(workspaceTasks.serverId, serverId),
    ))
    .limit(1);
  if (!task) return null;
  return { title: task.title, description: task.description ?? null };
}

/**
 * Resolve the serverId + ticket title/description for an assign or clarification request.
 * Returns null if the project or ticket cannot be found (caller should treat as 404).
 */
export async function getTicketForAssign(
  widgetProjectId: string,
  ticketId: string,
): Promise<{ serverId: string; title: string; description: string | null } | null> {
  const serverId = await resolveWidgetServerId(widgetProjectId);
  if (!serverId) return null;

  const task = await getWidgetTaskRow(serverId, ticketId);
  if (!task) return null;

  return { serverId, title: task.title, description: task.description };
}

export async function assignAgent(
  widgetProjectId: string,
  ticketId: string,
  req: AssignAgentRequest,
): Promise<AssignAgentResult> {
  const serverId = await resolveWidgetServerId(widgetProjectId);
  if (!serverId) throw new WidgetAssignError('project_not_found', 404);

  const task = await getWidgetTaskRow(serverId, ticketId);
  if (!task) throw new WidgetAssignError('ticket_not_found', 404);

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) throw new WidgetAssignError('server_not_found', 404);

  let res: { jobId?: string } | null = null;
  try {
    res = await ServerService.serverTokenFetch<{ jobId?: string }>(
      server,
      '/api/internal/widget-triager-assign',
      {
        ticketId,
        agentId: req.agentId,
        command: req.command,
        actor: {
          externalUserId: req.actor.externalUserId,
          name: req.actor.name,
          via: 'widget_triage',
        },
        ...(req.qa && req.qa.length > 0 ? { clarification: { qa: req.qa } } : {}),
      },
    );
  } catch (err) {
    throw new WidgetAssignError('workspace_unreachable', 503, err);
  }
  if (!res?.jobId) throw new WidgetAssignError('workspace_error', 502, res);

  // Audit row — best-effort; do not fail the request if this errors.
  try {
    await db.insert(workspaceTaskActivity).values({
      taskId: ticketId,
      serverId,
      type: 'agent_assigned',
      createdByType: 'external',
      createdById: req.actor.widgetUserId,
      createdByName: req.actor.name,
      metadata: {
        via: 'widget_triage',
        widget_user_id: req.actor.widgetUserId,
        external_user_id: req.actor.externalUserId,
        agent_id: req.agentId,
        command: req.command,
        matched_roles: req.actor.matchedRoles,
      },
    });
  } catch (err) {
    console.warn('[WidgetService] audit row write failed:', err);
  }

  return { jobId: res.jobId };
}

// ============================================================================
// Assignment Suggestion
// ============================================================================

export interface SuggestAssignmentResult {
  agentId: string | null;
  command: string;
}

/**
 * Ask the workspace's triager to suggest which exposed agent should handle
 * the given ticket.
 *
 * Non-fatal: any forwarding failure returns { agentId: null, command: '' } so
 * the modal stays usable even when the workspace is offline or the endpoint
 * hasn't been deployed yet.
 */
export async function suggestAssignment(
  widgetProjectId: string,
  ticketId: string,
): Promise<SuggestAssignmentResult> {
  // Resolve calling project → server (cross-tenant guard)
  const [proj] = await db
    .select({ serverId: widgetProjects.serverId })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, widgetProjectId))
    .limit(1);
  if (!proj) return { agentId: null, command: '' };

  // Resolve ticket → server, scoped to the calling project's server
  const [task] = await db
    .select({ serverId: workspaceTasks.serverId })
    .from(workspaceTasks)
    .where(and(
      eq(workspaceTasks.id, ticketId),
      eq(workspaceTasks.sourceType, 'widget'),
      eq(workspaceTasks.serverId, proj.serverId),
    ))
    .limit(1);
  if (!task) return { agentId: null, command: '' };

  // Only forward when there are agents exposed for this widget project
  const exposed = await listExposedAgents(widgetProjectId);
  if (exposed.length === 0) return { agentId: null, command: '' };
  const agentIdAllowlist = exposed.map(a => a.id);

  // Resolve server row (needed for URL + token hash)
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, task.serverId))
    .limit(1);
  if (!server) return { agentId: null, command: '' };

  try {
    const res = await ServerService.serverTokenFetch<{ agentId: string | null; command: string }>(
      server,
      '/api/internal/widget-triager-suggest',
      { ticketId, agentIdAllowlist },
    );
    return {
      agentId: typeof res?.agentId === 'string' ? res.agentId : null,
      command: typeof res?.command === 'string' ? res.command : '',
    };
  } catch (err) {
    console.warn('[WidgetService] suggestAssignment forward failed:', err);
    return { agentId: null, command: '' };
  }
}

// ============================================================================
// Exposed-Agent Mirror (pushed by workspace on every toggle and on boot)
// ============================================================================

export interface SyncWidgetExposedAgentsInput {
  workspaceProjectId: string;
  agents: Array<{ id: string; name: string; description: string | null }>;
}

export interface SyncWidgetExposedAgentsResult {
  upserted: number;
  removed: number;
}

/**
 * Full-replace per-(serverId, workspaceProjectId): atomic delete + insert.
 * Projects in the input are replaced in their entirety; projects NOT in the
 * input are left untouched (caller can sync incrementally).
 *
 * Silently skips projects that don't have a corresponding widget_projects row
 * (widget hasn't been enabled for that workspace project yet).
 */
export async function syncWidgetExposedAgents(
  serverId: string,
  projects: SyncWidgetExposedAgentsInput[],
): Promise<SyncWidgetExposedAgentsResult> {
  let upserted = 0;
  let removed = 0;

  for (const proj of projects) {
    const [wp] = await db
      .select({ id: widgetProjects.id })
      .from(widgetProjects)
      .where(and(
        eq(widgetProjects.serverId, serverId),
        eq(widgetProjects.workspaceProjectId, proj.workspaceProjectId),
      ))
      .limit(1);
    if (!wp) continue;

    await db.transaction(async (tx) => {
      const oldRows = await tx
        .select({ agentId: widgetExposedAgents.agentId })
        .from(widgetExposedAgents)
        .where(eq(widgetExposedAgents.widgetProjectId, wp.id));
      await tx.delete(widgetExposedAgents).where(eq(widgetExposedAgents.widgetProjectId, wp.id));
      if (proj.agents.length > 0) {
        await tx.insert(widgetExposedAgents).values(proj.agents.map(a => ({
          widgetProjectId: wp.id,
          agentId: a.id,
          agentName: a.name,
          agentDescription: a.description ?? null,
        })));
      }
      upserted += proj.agents.length;
      removed += oldRows.length;
    });
  }

  return { upserted, removed };
}
