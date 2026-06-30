/**
 * WidgetChatService — BE backbone for the widget "Chat with Agent" intake.
 *
 * BE Postgres is the source of truth for conversations + transcripts
 * (workspace agent loops are disposable; history is rehydrated from here on
 * every turn). Turns dispatch BE→workspace via the HMAC-signed
 * POST /api/internal/widget-chat/turn (Task 5); the workspace reports events
 * back through POST /api/internal/widget-chat/events → ingestTurnEvents
 * (Task 6), idempotent on the (turn_id, seq) partial unique index.
 *
 * Privacy: every public entry point takes (conversationId, projectId,
 * widgetUserId) and resolves through getConversationOwned — non-owners get
 * conversation_not_found, never an existence signal.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  servers,
  widgetChatConversations,
  widgetChatImages,
  widgetChatMessages,
  widgetClarifications,
  widgetExposedAgents,
  widgetProjects,
  widgetUsers,
  workspaceTaskActivity,
  workspaceTasks,
  type ChatImageRow,
  type WidgetChatEventPayload,
  type WidgetChatMessagePayload,
} from '../../db/schema';
import * as ServerService from './ServerService';
import * as WidgetService from './WidgetService';
import { autoAssignTicket as autoAssignTicketDefault } from './WidgetAutoAssign';
import { TaskAttachmentStorageService } from './TaskAttachmentStorageService';

/**
 * Fire-and-forget auto-assign hook, invoked after a widget ticket is created
 * from a conversation. Indirected through a module-level binding so tests can
 * install a spy (and avoid touching the real orchestrator). Production wiring is
 * the real, self-contained `autoAssignTicket` (resolves its own deps, never
 * throws). Callers MUST invoke as `void triggerAutoAssign(...)`.
 */
type AutoAssignHook = (
  projectId: string,
  ticketId: string,
  widgetUserId: string | undefined,
  opts?: { creatorCanAssign?: boolean },
) => void;

let autoAssignImpl: AutoAssignHook = (projectId, ticketId, widgetUserId, opts) => {
  void autoAssignTicketDefault(projectId, ticketId, widgetUserId, opts);
};

/** Test seam: override the auto-assign hook. Returns a restore function. */
export function __setAutoAssignForTests(fn: AutoAssignHook): () => void {
  const prev = autoAssignImpl;
  autoAssignImpl = fn;
  return () => {
    autoAssignImpl = prev;
  };
}

function triggerAutoAssign(
  projectId: string,
  ticketId: string,
  widgetUserId: string | undefined,
  opts?: { creatorCanAssign?: boolean },
): void {
  autoAssignImpl(projectId, ticketId, widgetUserId, opts);
}

export type ChatConversationRow = typeof widgetChatConversations.$inferSelect;
export type ChatMessageRow = typeof widgetChatMessages.$inferSelect;
export type { WidgetChatEventPayload };

/** Events the workspace reports back for a turn. seq orders them; turn_done completes the turn. */
export type TurnEventInput =
  | { seq: number; kind: 'agent_message'; text?: unknown }
  | { seq: number; kind: 'team_message'; text?: unknown; authorName?: unknown }
  | { seq: number; kind: 'proposal'; title?: unknown; description?: unknown; toolUseId?: unknown }
  | { seq: number; kind: 'ticket_link'; ticketId?: unknown }
  | { seq: number; kind: 'search_performed'; query?: unknown; resultText?: unknown }
  | { seq: number; kind: 'assigned'; ticketId?: unknown; agentEntityId?: unknown }
  | { seq: number; kind: 'turn_error'; message?: unknown }
  | { seq: number; kind: 'turn_done' };

export interface IngestResult {
  inserted: number;
  turnDone: boolean;
}

/**
 * The LATEST proposal in a transcript plus how (whether) the user resolved
 * it. The dangling propose_ticket tool_use must be answered on the next turn
 * (Anthropic API constraint): noAction → the workspace synthesizes a
 * "user continued the conversation" tool_result; created/dismissed carry the
 * real outcome.
 */
export interface PendingProposal {
  toolUseId: string;
  title: string;
  description: string;
  resolution: { noAction: true } | { created: true; ticketId: string } | { dismissed: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_USER_TURNS = 30;
const RESUME_MESSAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// In-process pub/sub (feeds the SSE route). One BE pod per widget user — the
// same stickiness assumption the WidgetRateLimiter already makes.
// ---------------------------------------------------------------------------

type Subscriber = (row: ChatMessageRow) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeToConversation(conversationId: string, cb: Subscriber): () => void {
  let set = subscribers.get(conversationId);
  if (!set) {
    set = new Set();
    subscribers.set(conversationId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(conversationId);
  };
}

/** Fan a newly persisted row out to live SSE subscribers. Never throws. */
function publish(row: ChatMessageRow): void {
  const set = subscribers.get(row.conversationId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(row);
    } catch (err) {
      console.warn('[WidgetChatService] subscriber threw:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Project + conversation accessors
// ---------------------------------------------------------------------------

interface ChatProject {
  id: string;
  serverId: string;
  workspaceProjectId: string | null;
  widgetChatAgentEntityId: string | null;
}

async function getChatProject(projectId: string): Promise<ChatProject | null> {
  const [project] = await db
    .select({
      id: widgetProjects.id,
      serverId: widgetProjects.serverId,
      workspaceProjectId: widgetProjects.workspaceProjectId,
      widgetChatAgentEntityId: widgetProjects.widgetChatAgentEntityId,
    })
    .from(widgetProjects)
    .where(eq(widgetProjects.id, projectId))
    .limit(1);
  return project ?? null;
}

/**
 * Owner-scoped conversation load. ONE error for "missing", "someone else's",
 * "different project", and "not even a uuid" — existence never leaks to
 * non-owners.
 */
export async function getConversationOwned(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
): Promise<ChatConversationRow> {
  if (!UUID_RE.test(conversationId)) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  const [conv] = await db
    .select()
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!conv || conv.widgetProjectId !== projectId || conv.widgetUserId !== widgetUserId) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  return conv;
}

/**
 * Like getConversationOwned, but also lets a `live_coder` staff member read a
 * ticket-linked conversation they don't own. The Live session relay container is
 * created owned by ONE widget user (the reporter, or the staff member who opened
 * it first), but ANY staff with `live_coder` must be able to read the running
 * coder's progress for a ticket in their project — not just the owner. Reporter
 * access (owner) is unchanged. Used by the live-session READ paths (message
 * history + the events SSE); the reporter-action paths keep getConversationOwned.
 */
export async function getConversationForViewer(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  permissions: ReadonlySet<WidgetService.WidgetPermission>,
): Promise<ChatConversationRow> {
  if (!UUID_RE.test(conversationId)) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  const [conv] = await db
    .select()
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!conv || conv.widgetProjectId !== projectId) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  // Owner always reads; a live_coder staff member reads any ticket-linked
  // (Live session) conversation in their project.
  if (conv.widgetUserId === widgetUserId) return conv;
  if (conv.createdTaskId && permissions.has('live_coder')) return conv;
  throw new WidgetService.WidgetError('conversation_not_found', 404);
}

/** Ownership + still-active gate for every mutating chat call. */
async function requireWritableConversation(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
): Promise<ChatConversationRow> {
  const conv = await getConversationOwned(conversationId, projectId, widgetUserId);
  if (conv.status !== 'active') {
    throw new WidgetService.WidgetError('conversation_closed', 409);
  }
  return conv;
}

/** Full transcript, canonical order (created_at, id). */
async function loadAllMessages(conversationId: string): Promise<ChatMessageRow[]> {
  return db
    .select()
    .from(widgetChatMessages)
    .where(eq(widgetChatMessages.conversationId, conversationId))
    .orderBy(widgetChatMessages.createdAt, widgetChatMessages.id);
}

/** Resume window: the last RESUME_MESSAGE_LIMIT rows, returned oldest→newest. */
async function loadRecentMessages(conversationId: string): Promise<ChatMessageRow[]> {
  const rows = await db
    .select()
    .from(widgetChatMessages)
    .where(eq(widgetChatMessages.conversationId, conversationId))
    .orderBy(desc(widgetChatMessages.createdAt), desc(widgetChatMessages.id))
    .limit(RESUME_MESSAGE_LIMIT);
  return rows.reverse();
}

async function findActiveConversation(
  projectId: string,
  widgetUserId: string,
): Promise<ChatConversationRow | null> {
  const [conv] = await db
    .select()
    .from(widgetChatConversations)
    .where(and(
      eq(widgetChatConversations.widgetProjectId, projectId),
      eq(widgetChatConversations.widgetUserId, widgetUserId),
      eq(widgetChatConversations.status, 'active'),
      // INTAKE conversations only. A conversation with createdTaskId set is a
      // ticket's Live-session relay container (or a chat that already produced a
      // ticket), NOT a general "Chat with Agent" intake — resuming it here would
      // surface a coder's progress messages when the user just wanted a fresh
      // chat. Those are reached explicitly via the ticket's Live session button.
      isNull(widgetChatConversations.createdTaskId),
    ))
    .orderBy(desc(widgetChatConversations.createdAt))
    .limit(1);
  return conv ?? null;
}

export interface ConversationBundle {
  conversation: ChatConversationRow;
  messages: ChatMessageRow[];
  /**
   * Whether ANY agent turn has touched this conversation (a turn is pending,
   * or a persisted row carries a turn_id / role='agent'). The widget keys the
   * agentless collect-prompt/[Submit Ticket] affordance off this — once an
   * agent turn occurs, the agent flow's proposal mechanism owns the
   * conversation. Derived (never stored): the source of truth is the
   * transcript itself.
   */
  hasAgentTurns: boolean;
}

/**
 * Whether any agent turn has touched the conversation. pending_turn_id counts
 * (a dispatched turn that has not reported back yet is still an agent turn),
 * as do BE-written agent_unavailable notices (they carry the turn_id).
 */
export async function conversationHasAgentTurns(
  conv: Pick<ChatConversationRow, 'id' | 'pendingTurnId'>,
): Promise<boolean> {
  if (conv.pendingTurnId) return true;
  const [row] = await db
    .select({ id: widgetChatMessages.id })
    .from(widgetChatMessages)
    .where(and(
      eq(widgetChatMessages.conversationId, conv.id),
      sql`(${widgetChatMessages.turnId} IS NOT NULL OR ${widgetChatMessages.role} = 'agent')`,
    ))
    .limit(1);
  return row !== undefined;
}

/**
 * Start-or-resume: the widget's chat entry point ("Chat with Agent" card, or
 * "Send us a message" when no agent is configured — agentless conversations
 * ride the same backbone and simply never dispatch turns). Concurrent
 * first-opens can race into two active rows; findActiveConversation picks the
 * newest and the loser simply goes unused — harmless for this surface.
 */
export async function getOrCreateActiveConversation(
  projectId: string,
  widgetUserId: string,
): Promise<ConversationBundle> {
  const project = await getChatProject(projectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);
  const existing = await findActiveConversation(projectId, widgetUserId);
  if (existing) {
    return {
      conversation: existing,
      messages: await loadRecentMessages(existing.id),
      hasAgentTurns: await conversationHasAgentTurns(existing),
    };
  }
  const [conversation] = await db
    .insert(widgetChatConversations)
    .values({ widgetProjectId: projectId, widgetUserId })
    .returning();
  return { conversation: conversation!, messages: [], hasAgentTurns: false };
}

export async function getActiveConversation(
  projectId: string,
  widgetUserId: string,
): Promise<ConversationBundle | null> {
  const conv = await findActiveConversation(projectId, widgetUserId);
  if (!conv) return null;
  return {
    conversation: conv,
    messages: await loadRecentMessages(conv.id),
    hasAgentTurns: await conversationHasAgentTurns(conv),
  };
}

/**
 * Owner-scoped message listing. `after` = a message id cursor; only rows
 * strictly newer (by the canonical (created_at, id) order) are returned.
 * The comparison stays entirely in SQL: created_at has microsecond precision
 * in Postgres but only milliseconds after a JS Date round-trip, which would
 * make the boundary row reappear.
 */
export async function listMessages(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  permissions: ReadonlySet<WidgetService.WidgetPermission>,
  after?: string,
): Promise<ChatMessageRow[]> {
  // Read access: the owner (reporter) OR a live_coder staff member viewing a
  // ticket-linked Live session.
  await getConversationForViewer(conversationId, projectId, widgetUserId, permissions);
  if (!after) return loadAllMessages(conversationId);
  if (!UUID_RE.test(after)) throw new WidgetService.WidgetError('invalid_cursor', 400);
  const [anchor] = await db
    .select({ id: widgetChatMessages.id })
    .from(widgetChatMessages)
    .where(and(
      eq(widgetChatMessages.id, after),
      eq(widgetChatMessages.conversationId, conversationId),
    ))
    .limit(1);
  if (!anchor) throw new WidgetService.WidgetError('invalid_cursor', 400);
  return db
    .select()
    .from(widgetChatMessages)
    .where(and(
      eq(widgetChatMessages.conversationId, conversationId),
      sql`(${widgetChatMessages.createdAt}, ${widgetChatMessages.id}) > (
        SELECT m.created_at, m.id FROM widget_chat_messages m
        WHERE m.id = ${after} AND m.conversation_id = ${conversationId}
      )`,
    ))
    .orderBy(widgetChatMessages.createdAt, widgetChatMessages.id);
}

// ---------------------------------------------------------------------------
// Pure transcript helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Attachment storage seam (injectable for tests)
// ---------------------------------------------------------------------------

interface AttachmentStorage {
  isConfigured(): boolean;
  getObjectBuffer(input: { storageProvider: 'r2' | 's3'; storageKey: string }): Promise<Buffer>;
  createDownloadUrl(input: { storageProvider: 'r2' | 's3'; storageKey: string; originalName?: string | null }, options?: { ttlSeconds?: number }): Promise<string | null>;
}

let attachmentStorageImpl: AttachmentStorage = new TaskAttachmentStorageService();

/** Test seam: override the attachment storage service. Returns a restore function. */
export function __setAttachmentStorageForTests(svc: AttachmentStorage): () => void {
  const prev = attachmentStorageImpl;
  attachmentStorageImpl = svc;
  return () => {
    attachmentStorageImpl = prev;
  };
}

export type TranscriptEntry =
  | { role: 'user' | 'agent'; content: string; images?: { mime: string; dataBase64: string }[] }
  | { role: 'event'; payload: WidgetChatEventPayload };

/**
 * Map persisted rows onto the turn-dispatch transcript shape. Async: when
 * `conversationId` is provided and object storage is configured, user rows that
 * have linked `widget_chat_images` are enriched with the base64-encoded model
 * derivative (≤1024px JPEG). The `images` field is OMITTED (not `[]`) when a
 * user row has no linked images, keeping the shape additive and backward-compatible.
 *
 * Non-user rows (agent, event) never carry images. role='team' rows are EXCLUDED —
 * the workspace turn contract only knows user/agent/event entries.
 *
 * When `conversationId` is omitted the function behaves identically to the
 * previous pure-sync version (no DB or storage access).
 */
export async function buildTranscript(
  rows: Array<Pick<ChatMessageRow, 'role' | 'content' | 'payload'> & { id?: string }>,
  conversationId?: string,
): Promise<TranscriptEntry[]> {
  // Collect IDs of all user rows — including image-only (empty-content) rows.
  const userRowIds: string[] = [];
  for (const row of rows) {
    if (row.role === 'user' && row.id) {
      userRowIds.push(row.id);
    }
  }

  // Batch-load images when all conditions are met: we have user rows, a
  // conversationId to scope the query, and configured storage to fetch bytes.
  const byMessageId = new Map<string, Array<{ modelStorageProvider: 'r2' | 's3'; modelStorageKey: string }>>();
  if (userRowIds.length > 0 && conversationId && attachmentStorageImpl.isConfigured()) {
    const imageRows = await db
      .select({
        messageId: widgetChatImages.messageId,
        modelStorageProvider: widgetChatImages.modelStorageProvider,
        modelStorageKey: widgetChatImages.modelStorageKey,
      })
      .from(widgetChatImages)
      .where(inArray(widgetChatImages.messageId, userRowIds));
    for (const img of imageRows) {
      if (!img.messageId) continue;
      const list = byMessageId.get(img.messageId);
      if (list) {
        list.push({ modelStorageProvider: img.modelStorageProvider, modelStorageKey: img.modelStorageKey });
      } else {
        byMessageId.set(img.messageId, [{ modelStorageProvider: img.modelStorageProvider, modelStorageKey: img.modelStorageKey }]);
      }
    }
  }

  const out: TranscriptEntry[] = [];
  for (const row of rows) {
    if (row.role === 'event') {
      // 'kind' in — narrows away the role='team' attribution payload shape.
      if (row.payload && 'kind' in row.payload) out.push({ role: 'event', payload: row.payload });
    } else if (row.role !== 'team' && (row.content || (row.role === 'user' && row.id && byMessageId.has(row.id)))) {
      if (row.role === 'user' && row.id && byMessageId.has(row.id)) {
        // User row with linked images: fetch each model derivative and base64-encode.
        const imgList = byMessageId.get(row.id)!;
        const images: { mime: string; dataBase64: string }[] = [];
        for (const img of imgList) {
          const buffer = await attachmentStorageImpl.getObjectBuffer({
            storageProvider: img.modelStorageProvider,
            storageKey: img.modelStorageKey,
          });
          images.push({ mime: 'image/jpeg', dataBase64: buffer.toString('base64') });
        }
        out.push({ role: 'user', content: row.content, images });
      } else {
        out.push({ role: row.role as 'user' | 'agent', content: row.content });
      }
    }
  }
  return out;
}

/**
 * Derive the LATEST proposal and its resolution state from a chronologically
 * ordered transcript. A proposal_resolved row resolves the most recent
 * proposal before it; a proposal with no later resolution is pending
 * ({ noAction: true }). created:true without a ticketId is treated as
 * dismissed (defensive — that combination should not exist).
 */
export function computePendingProposal(
  rows: Pick<ChatMessageRow, 'role' | 'payload'>[],
): PendingProposal | null {
  let pending: PendingProposal | null = null;
  for (const row of rows) {
    const p = row.payload;
    if (!p || !('kind' in p)) continue;
    if (p.kind === 'proposal') {
      pending = {
        toolUseId: p.toolUseId,
        title: p.title,
        description: p.description,
        resolution: { noAction: true },
      };
    } else if (p.kind === 'proposal_resolved' && pending) {
      // Constructed explicitly (no `...pending` spread): spreading the
      // mutated loop variable creates a control-flow back-edge cycle in
      // TS 5.9's inference (the reassignment's type depends on the spread,
      // which depends on the variable's narrowed type, which depends on the
      // reassignment) and fails with TS2698.
      pending = {
        toolUseId: pending.toolUseId,
        title: pending.title,
        description: pending.description,
        resolution: p.created && p.ticketId
          ? { created: true, ticketId: p.ticketId }
          : { dismissed: true },
      };
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Turn timeout machinery
// ---------------------------------------------------------------------------

/**
 * Read at arm time (not module load) so tests can shrink the window via
 * WIDGET_CHAT_TURN_TIMEOUT_MS. Production default: 90s — long enough for a
 * multi-tool agent turn, short enough that the visitor isn't staring at a
 * dead typing indicator.
 */
function turnTimeoutMs(): number {
  const n = Number(process.env.WIDGET_CHAT_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
}

const turnTimeouts = new Map<string, NodeJS.Timeout>();

function cancelTurnTimeout(turnId: string): void {
  const timer = turnTimeouts.get(turnId);
  if (timer) {
    clearTimeout(timer);
    turnTimeouts.delete(turnId);
  }
}

/**
 * The graceful-degradation notice (workspace offline / turn timed out).
 * Written with (turnId, seq=null) so a LATE turn_done can find and delete it
 * (ingestTurnEvents) — model output is paid for, so late replies replace the
 * failure state. No-ops if the turn already completed or was superseded.
 */
async function writeAgentUnavailableNotice(conversationId: string, turnId: string): Promise<void> {
  const [conv] = await db
    .select()
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!conv || conv.pendingTurnId !== turnId) return;
  const [notice] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'event',
      turnId,
      seq: null,
      payload: {
        kind: 'system_notice',
        code: 'agent_unavailable',
        text: 'The agent is unavailable right now. Please try again in a moment, or join the open discussion instead.',
      },
    })
    .returning();
  if (notice) publish(notice);
  await db
    .update(widgetChatConversations)
    .set({ pendingTurnId: null, updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));
}

function armTurnTimeout(conversationId: string, turnId: string): void {
  const timer = setTimeout(() => {
    turnTimeouts.delete(turnId);
    void writeAgentUnavailableNotice(conversationId, turnId).catch((err) => {
      console.error('[WidgetChatService] timeout notice failed:', err);
    });
  }, turnTimeoutMs());
  // Never hold the process open for a pending widget turn (also lets vitest exit).
  timer.unref?.();
  turnTimeouts.set(turnId, timer);
}

// ---------------------------------------------------------------------------
// Turn dispatch + user messages
// ---------------------------------------------------------------------------

/**
 * Dispatch one agent turn to the workspace. Stamps pending_turn_id BEFORE the
 * HTTP call (the events callback may race the ACK), arms the timeout, and
 * degrades to an agent_unavailable notice when the workspace is unreachable.
 * The transcript is rebuilt from Postgres every turn — the workspace holds no
 * durable conversation state. The workspace ACKs fast (the 10s transport
 * timeout covers the ACK only; the turn itself runs async under the 90s
 * window) and reports events to POST /api/internal/widget-chat/events.
 */
async function dispatchTurn(
  conversation: ChatConversationRow,
  opts: { forceProposal?: boolean } = {},
): Promise<string> {
  const project = await getChatProject(conversation.widgetProjectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);
  if (!project.widgetChatAgentEntityId) {
    throw new WidgetService.WidgetError('chat_not_enabled', 409);
  }

  const turnId = randomUUID();
  await db
    .update(widgetChatConversations)
    .set({ pendingTurnId: turnId, updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversation.id));

  const rows = await loadAllMessages(conversation.id);
  const pending = computePendingProposal(rows);

  const [server] = await db.select().from(servers).where(eq(servers.id, project.serverId)).limit(1);
  if (!server) {
    await writeAgentUnavailableNotice(conversation.id, turnId);
    return turnId;
  }

  armTurnTimeout(conversation.id, turnId);
  try {
    await ServerService.serverTokenFetch(
      server,
      '/api/internal/widget-chat/turn',
      {
        conversationId: conversation.id,
        turnId,
        serverId: project.serverId,
        projectId: project.workspaceProjectId,
        agentEntityId: project.widgetChatAgentEntityId,
        chatInstructions: null,
        forceProposal: opts.forceProposal === true,
        transcript: await buildTranscript(rows, conversation.id),
        pendingProposal: pending
          ? { toolUseId: pending.toolUseId, resolution: pending.resolution }
          : null,
      },
      { timeoutMs: 10_000 },
    );
  } catch (err) {
    console.warn('[WidgetChatService] turn dispatch failed:', err);
    cancelTurnTimeout(turnId);
    await writeAgentUnavailableNotice(conversation.id, turnId);
  }
  return turnId;
}

/**
 * Idempotently append the agentless collect_prompt event ("anything more
 * you'd like to add?" + [Submit Ticket] affordance in the widget). Added
 * after the FIRST user message of an agentless conversation; subsequent
 * messages find the existing row and no-op.
 */
async function ensureCollectPrompt(conversationId: string): Promise<void> {
  const [existing] = await db
    .select({ id: widgetChatMessages.id })
    .from(widgetChatMessages)
    .where(and(
      eq(widgetChatMessages.conversationId, conversationId),
      sql`${widgetChatMessages.payload}->>'kind' = 'collect_prompt'`,
    ))
    .limit(1);
  if (existing) return;
  const [prompt] = await db
    .insert(widgetChatMessages)
    .values({ conversationId, role: 'event', payload: { kind: 'collect_prompt' } })
    .returning();
  if (prompt) publish(prompt);
}

/**
 * Append a user message and trigger a turn — or, when no support agent is
 * configured (agentless intake), skip turn dispatch entirely and append the
 * one-time collect_prompt event instead. The agent-configured check happens
 * at SEND time, so an agent configured mid-conversation picks up the thread
 * on the very next message. Caps: 4000 chars per message, 30 user turns per
 * conversation (abuse backstop — each turn is paid model time). The HTTP
 * layer additionally rate-limits via the chat_message bucket.
 *
 * Optional imageIds: previously-uploaded chat images to attach to this message.
 * Validated BEFORE the message row is inserted (invalid refs produce no row).
 * After insert, the image rows are updated to set their message_id.
 */
export async function sendUserMessage(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  content: string,
  imageIds?: string[],
): Promise<ChatMessageRow> {
  const text = content.trim();
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new WidgetService.WidgetError('message_too_long', 400);
  }

  // Count cap: fast path, no DB query needed.
  if (imageIds && imageIds.length > WidgetService.MAX_CHAT_IMAGES_PER_MESSAGE) {
    throw new WidgetService.WidgetError('attachment_count_exceeded', 400);
  }

  const conversation = await requireWritableConversation(conversationId, projectId, widgetUserId);
  if (conversation.userTurnCount >= MAX_USER_TURNS) {
    throw new WidgetService.WidgetError('turn_limit_reached', 409);
  }
  const project = await getChatProject(projectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);

  // Image ref validation: BEFORE the message insert — invalid refs must not
  // produce a message row. The query enforces ownership (conversationId +
  // widgetUserId) and confirms no prior link (messageId IS NULL).
  let validatedImageIds: string[] = [];
  if (imageIds && imageIds.length > 0) {
    const validRows = await db
      .select({ id: widgetChatImages.id })
      .from(widgetChatImages)
      .where(and(
        inArray(widgetChatImages.id, imageIds),
        eq(widgetChatImages.conversationId, conversationId),
        eq(widgetChatImages.widgetUserId, widgetUserId),
        isNull(widgetChatImages.messageId),
      ));
    if (validRows.length !== imageIds.length) {
      throw new WidgetService.WidgetError('invalid_image_ref', 400);
    }
    validatedImageIds = validRows.map((r) => r.id);
  }

  // Require either non-empty text or at least one validated image.
  if (!text && validatedImageIds.length === 0) {
    throw new WidgetService.WidgetError('message_required', 400);
  }

  const [message] = await db
    .insert(widgetChatMessages)
    .values({ conversationId, role: 'user', content: text })
    .returning();

  await db
    .update(widgetChatConversations)
    .set({
      userTurnCount: sql`${widgetChatConversations.userTurnCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(widgetChatConversations.id, conversationId));

  // Link images to the new message after the row exists; publish AFTER so SSE
  // subscribers see the FK already written.
  if (validatedImageIds.length > 0) {
    await db
      .update(widgetChatImages)
      .set({ messageId: message!.id })
      .where(inArray(widgetChatImages.id, validatedImageIds));
  }
  publish(message!);

  if (project.widgetChatAgentEntityId) {
    await dispatchTurn(conversation);
  } else {
    await ensureCollectPrompt(conversationId);
  }
  return message!;
}

/**
 * Anti-"AI jail" escape hatch: the widget's "Create ticket from this
 * conversation" link. Appends a visible marker event and forces the next
 * turn to call propose_ticket from what the agent already has.
 */
export async function forceProposal(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
): Promise<void> {
  const conversation = await requireWritableConversation(conversationId, projectId, widgetUserId);
  const [marker] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'event',
      payload: { kind: 'force_proposal_requested' },
    })
    .returning();
  publish(marker!);
  await dispatchTurn(conversation, { forceProposal: true });
}

// ---------------------------------------------------------------------------
// Proposal confirmation / dismissal
// ---------------------------------------------------------------------------

const MAX_DRAFT_TITLE_LENGTH = 300;
const MAX_DRAFT_DESCRIPTION_LENGTH = 10_000;

/**
 * Shared helper: carry all `widget_chat_images` for a conversation onto a
 * newly-created task as `workspaceTaskAttachments`. References the ORIGINAL
 * storage object directly — no copy needed or possible. Best-effort: a
 * failing insert for one image logs a warning and moves on; the other images
 * and the ticket itself are unaffected.
 */
async function carryConversationImagesToTask(
  conversationId: string,
  serverId: string,
  taskId: string,
): Promise<void> {
  let imgs: (typeof widgetChatImages.$inferSelect)[];
  try {
    imgs = await db
      .select()
      .from(widgetChatImages)
      .where(
        and(
          eq(widgetChatImages.conversationId, conversationId),
          isNotNull(widgetChatImages.messageId),
        ),
      );
  } catch (err) {
    console.warn('[WidgetChatService] failed to load chat images for carry-over', { conversationId, taskId, err });
    return;
  }
  for (const img of imgs) {
    try {
      await WidgetService.linkExistingTaskAttachment({
        serverId,
        taskId,
        storageProvider: img.originalStorageProvider,
        storageKey: img.originalStorageKey,
        mimeType: img.mimeType,
        originalName: img.originalName,
      });
    } catch (err) {
      console.warn('[WidgetChatService] failed to carry chat image onto ticket', {
        conversationId,
        taskId,
        imageId: img.id,
        err,
      });
    }
  }
}

/** The latest proposal, iff still unresolved. Throws no_pending_proposal otherwise. */
async function requirePendingProposal(conversationId: string): Promise<PendingProposal> {
  const rows = await loadAllMessages(conversationId);
  const pending = computePendingProposal(rows);
  if (!pending || !('noAction' in pending.resolution)) {
    throw new WidgetService.WidgetError('no_pending_proposal', 409);
  }
  return pending;
}

/**
 * The user confirmed the proposal card (possibly with edits). Creates the
 * ticket through the existing WidgetService create path, born READY: a
 * widget_clarifications row with status='skipped' marks the conversation as
 * having BEEN the clarification (and search_tickets as having been the
 * dedup), so the ticket-detail UI shows no clarifying state and the human
 * triager flow treats it as settled.
 *
 * The conversation stays ACTIVE: the post-creation turn delivers the
 * {created:true, ticketId} tool result to the agent (which may assign), and
 * BE closes the conversation on that turn's turn_done (see ingestTurnEvents).
 */
export async function createTicketFromChat(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  draft: { title?: string; description?: string },
  /** Whether the reporter holds `assign_agent`; gates automatic assignment. */
  creatorCanAssign = true,
): Promise<{ ticketId: string }> {
  const fresh = await requireWritableConversation(conversationId, projectId, widgetUserId);
  await requirePendingProposal(conversationId);

  const title = (draft.title ?? '').trim();
  const description = (draft.description ?? '').trim();
  if (!title || title.length > MAX_DRAFT_TITLE_LENGTH || description.length > MAX_DRAFT_DESCRIPTION_LENGTH) {
    throw new WidgetService.WidgetError('invalid_proposal_draft', 400);
  }

  const project = await getChatProject(projectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);

  const task = await WidgetService.createTicket(projectId, widgetUserId, { title, description });

  // Carry all images from the conversation onto the new ticket as task attachments.
  // Best-effort: a failing insert must not abort the already-created ticket.
  await carryConversationImagesToTask(conversationId, project.serverId, task.id);

  // Clarifier suppression: 'skipped' is the codebase's native "no clarifying
  // state" marker (getTicketClarification orders 'skipped' rows last; the
  // widget detail renders nothing for it).
  await db.insert(widgetClarifications).values({
    taskId: task.id,
    serverId: project.serverId,
    widgetUserId,
    agentId: project.widgetChatAgentEntityId ?? 'widget_chat',
    command: 'widget_chat',
    status: 'skipped',
  });

  await db
    .update(widgetChatConversations)
    .set({ createdTaskId: task.id, updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));

  const [resolvedEvent] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'event',
      payload: { kind: 'proposal_resolved', created: true, ticketId: task.id },
    })
    .returning();
  publish(resolvedEvent!);

  // Fire-and-forget auto-assign: the single server-side authority decides
  // whether to start a coding agent (identity + per-creator authorization +
  // injection guard + agent picker). Independent of the post-creation turn,
  // which now only acknowledges/closes — it no longer assigns.
  triggerAutoAssign(projectId, task.id, widgetUserId, { creatorCanAssign });

  // Post-creation turn: computePendingProposal now derives
  // {created:true, ticketId} from the row just written.
  await dispatchTurn({ ...fresh, createdTaskId: task.id });

  return { ticketId: task.id };
}

// ---------------------------------------------------------------------------
// Agentless [Submit Ticket]
// ---------------------------------------------------------------------------

const SUBMIT_TITLE_MAX = 80;

/**
 * Server-side draft derivation for the agentless [Submit Ticket] flow — the
 * client never supplies the draft (the stored transcript is the source of
 * truth). Title: the first user message, whitespace-normalized to one line,
 * word-boundary-trimmed to ~80 chars with an ellipsis. Description: every
 * user message in chronological order, blank-line separated.
 */
export function deriveTicketDraft(userMessages: string[]): { title: string; description: string } {
  const messages = userMessages.map((m) => m.trim()).filter((m) => m.length > 0);
  const description = messages.join('\n\n');
  const firstLine = (messages[0] ?? '').replace(/\s+/g, ' ').trim();
  let title = firstLine;
  if (firstLine.length > SUBMIT_TITLE_MAX) {
    const cut = firstLine.slice(0, SUBMIT_TITLE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    // Backtrack to the last word boundary unless that would gut the title
    // (degenerate no-spaces input) — then a hard cut is the best we can do.
    title = `${(lastSpace > SUBMIT_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return { title, description };
}

/**
 * Agentless-only ticket creation: derives the draft from the STORED user
 * messages and creates the ticket through the same born-ready path
 * createTicketFromChat uses (clarifier 'skipped' — the conversation was the
 * intake). Unlike the agent flow there is no post-create turn, so the
 * conversation closes immediately after the proposal_resolved event.
 *
 * 409 codes (distinct per cause): ticket_already_created, conversation_closed,
 * agent_turns_present (the agent flow's proposal mechanism owns agent-driven
 * conversations), no_user_messages.
 */
export async function submitTicketFromConversation(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  /** Whether the reporter holds `assign_agent`; gates automatic assignment. */
  creatorCanAssign = true,
): Promise<{ ticketId: string }> {
  const conversation = await getConversationOwned(conversationId, projectId, widgetUserId);
  if (conversation.createdTaskId) {
    throw new WidgetService.WidgetError('ticket_already_created', 409);
  }
  if (conversation.status !== 'active') {
    throw new WidgetService.WidgetError('conversation_closed', 409);
  }
  if (await conversationHasAgentTurns(conversation)) {
    throw new WidgetService.WidgetError('agent_turns_present', 409);
  }

  const rows = await loadAllMessages(conversationId);
  const userMessages = rows
    .filter((r) => r.role === 'user' && r.content.trim().length > 0)
    .map((r) => r.content);
  if (userMessages.length === 0) {
    throw new WidgetService.WidgetError('no_user_messages', 409);
  }

  const project = await getChatProject(projectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);

  const { title, description } = deriveTicketDraft(userMessages);
  const task = await WidgetService.createTicket(projectId, widgetUserId, { title, description });

  // Carry all images from the conversation onto the new ticket as task attachments.
  // Best-effort: a failing insert must not abort the already-created ticket.
  await carryConversationImagesToTask(conversationId, project.serverId, task.id);

  // Born ready: same clarifier-suppression marker createTicketFromChat writes.
  await db.insert(widgetClarifications).values({
    taskId: task.id,
    serverId: project.serverId,
    widgetUserId,
    agentId: project.widgetChatAgentEntityId ?? 'widget_chat',
    command: 'widget_chat',
    status: 'skipped',
  });

  // Link first (the re-submission gate), then the visible card, then close —
  // a crash mid-sequence leaves a resumable state, never a duplicate ticket.
  await db
    .update(widgetChatConversations)
    .set({ createdTaskId: task.id, updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));

  const [resolvedEvent] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'event',
      payload: { kind: 'proposal_resolved', created: true, ticketId: task.id },
    })
    .returning();
  publish(resolvedEvent!);

  await db
    .update(widgetChatConversations)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));

  // Fire-and-forget auto-assign (same authority as the agent-chat path).
  triggerAutoAssign(projectId, task.id, widgetUserId, { creatorCanAssign });

  return { ticketId: task.id };
}

/** The user dismissed the proposal card. The next turn synthesizes {dismissed:true}. */
export async function dismissProposal(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
): Promise<void> {
  const fresh = await requireWritableConversation(conversationId, projectId, widgetUserId);
  await requirePendingProposal(conversationId);

  const [resolvedEvent] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'event',
      payload: { kind: 'proposal_resolved', created: false },
    })
    .returning();
  publish(resolvedEvent!);

  await dispatchTurn(fresh);
}

// ---------------------------------------------------------------------------
// Team side (Conversations inbox) — workspace-member surface behind
// /api/widget/team/*. Server-scoped, NOT widget-user-scoped: routes
// authenticate a runhq session member and resolve the server, then every
// accessor here re-verifies the conversation/project belongs to that server
// (cross-tenant access answers *_not_found, never an existence signal).
// ---------------------------------------------------------------------------

const PREVIEW_LENGTH = 140;

/** Inbox list/detail header shape (wire DTO — dates are ISO strings). */
export interface TeamConversationSummary {
  id: string;
  /** Widget visitor attribution: name, falling back to username / external id. */
  userDisplay: string;
  /** Latest non-empty message text (user/agent/team), truncated to 140 chars. */
  lastMessagePreview: string | null;
  /** Count of user/agent/team rows — event cards are not "messages". */
  messageCount: number;
  status: 'active' | 'closed';
  createdTaskId: string | null;
  /** Same derived flag the widget gets: any agent turn touched this thread. */
  hasAgentTurns: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Server-scoped conversation load for the team surface. ONE error for
 * "missing", "another server's", and "not even a uuid".
 */
async function getConversationForServer(
  serverId: string,
  conversationId: string,
): Promise<ChatConversationRow> {
  if (!UUID_RE.test(conversationId)) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  const [found] = await db
    .select({
      conversation: widgetChatConversations,
      projectServerId: widgetProjects.serverId,
    })
    .from(widgetChatConversations)
    .innerJoin(widgetProjects, eq(widgetChatConversations.widgetProjectId, widgetProjects.id))
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!found || found.projectServerId !== serverId) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  return found.conversation;
}

/**
 * Resolve which server a conversation belongs to (route-layer auth helper:
 * the /api/widget/team/:id routes must know the server BEFORE they can check
 * the session member's membership). Returns null for unknown/invalid ids so
 * the route can 404 without an existence oracle for non-members.
 */
export async function getTeamConversationServerId(conversationId: string): Promise<string | null> {
  if (!UUID_RE.test(conversationId)) return null;
  const [found] = await db
    .select({ serverId: widgetProjects.serverId })
    .from(widgetChatConversations)
    .innerJoin(widgetProjects, eq(widgetChatConversations.widgetProjectId, widgetProjects.id))
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  return found?.serverId ?? null;
}

/** Joined select shape shared by the list + detail summary queries. */
function teamSummaryColumns() {
  return {
    conversation: widgetChatConversations,
    userName: widgetUsers.name,
    userUsername: widgetUsers.username,
    userExternalId: widgetUsers.externalUserId,
    messageCount: sql<number>`(
      SELECT count(*)::int FROM widget_chat_messages m
      WHERE m.conversation_id = ${widgetChatConversations.id}
        AND m.role IN ('user', 'agent', 'team')
    )`,
    lastMessagePreview: sql<string | null>`(
      SELECT left(m.content, ${PREVIEW_LENGTH}) FROM widget_chat_messages m
      WHERE m.conversation_id = ${widgetChatConversations.id} AND m.content <> ''
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    )`,
    hasAgentTurns: sql<boolean>`(
      ${widgetChatConversations.pendingTurnId} IS NOT NULL OR EXISTS(
        SELECT 1 FROM widget_chat_messages m
        WHERE m.conversation_id = ${widgetChatConversations.id}
          AND (m.turn_id IS NOT NULL OR m.role = 'agent')
      )
    )`,
  };
}

type TeamSummaryRow = {
  conversation: ChatConversationRow;
  userName: string | null;
  userUsername: string | null;
  userExternalId: string;
  messageCount: number;
  lastMessagePreview: string | null;
  hasAgentTurns: boolean;
};

function toTeamSummary(row: TeamSummaryRow): TeamConversationSummary {
  return {
    id: row.conversation.id,
    userDisplay: row.userName || row.userUsername || row.userExternalId,
    lastMessagePreview: row.lastMessagePreview,
    messageCount: row.messageCount,
    status: row.conversation.status,
    createdTaskId: row.conversation.createdTaskId,
    hasAgentTurns: row.hasAgentTurns,
    createdAt: row.conversation.createdAt.toISOString(),
    updatedAt: row.conversation.updatedAt.toISOString(),
  };
}

/**
 * Inbox listing for one widget project (ALL conversations — agent-driven
 * included; the team can jump into any thread), newest activity first.
 * Addressed by workspaceProjectId because that is the id the runhq client
 * holds; (serverId, workspaceProjectId) pins the tenant.
 */
export async function listTeamConversations(
  serverId: string,
  workspaceProjectId: string,
): Promise<TeamConversationSummary[]> {
  const [project] = await db
    .select({ id: widgetProjects.id })
    .from(widgetProjects)
    .where(and(
      eq(widgetProjects.serverId, serverId),
      eq(widgetProjects.workspaceProjectId, workspaceProjectId),
    ))
    .limit(1);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);

  const rows = await db
    .select(teamSummaryColumns())
    .from(widgetChatConversations)
    .innerJoin(widgetUsers, eq(widgetChatConversations.widgetUserId, widgetUsers.id))
    .where(eq(widgetChatConversations.widgetProjectId, project.id))
    .orderBy(desc(widgetChatConversations.updatedAt), desc(widgetChatConversations.id));
  return rows.map(toTeamSummary);
}

export interface TeamConversationDetail {
  conversation: TeamConversationSummary;
  messages: ChatMessageRow[];
}

/** Full thread for the inbox: summary header + every row (all roles + events). */
export async function getTeamConversation(
  serverId: string,
  conversationId: string,
): Promise<TeamConversationDetail> {
  await getConversationForServer(serverId, conversationId);
  const [row] = await db
    .select(teamSummaryColumns())
    .from(widgetChatConversations)
    .innerJoin(widgetUsers, eq(widgetChatConversations.widgetUserId, widgetUsers.id))
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!row) throw new WidgetService.WidgetError('conversation_not_found', 404);
  return {
    conversation: toTeamSummary(row),
    messages: await loadAllMessages(conversationId),
  };
}

/**
 * Append a workspace member's reply as a role='team' row (payload carries
 * the author's display name) and fan it out over the conversation's SSE
 * stream — the widget renders it like an agent bubble, attributed. Works on
 * any OPEN conversation regardless of agent mode, and NEVER dispatches a
 * turn (a human reply is not model input until the user writes again, at
 * which point buildTranscript intentionally excludes team rows).
 */
export async function sendTeamReply(
  serverId: string,
  conversationId: string,
  authorName: string,
  content: string,
): Promise<ChatMessageRow> {
  const text = content.trim();
  if (!text) throw new WidgetService.WidgetError('message_required', 400);
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new WidgetService.WidgetError('message_too_long', 400);
  }

  const conversation = await getConversationForServer(serverId, conversationId);
  if (conversation.status !== 'active') {
    throw new WidgetService.WidgetError('conversation_closed', 409);
  }

  const [message] = await db
    .insert(widgetChatMessages)
    .values({
      conversationId,
      role: 'team',
      content: text,
      payload: { authorName: authorName.trim() || 'Team' },
    })
    .returning();
  publish(message!);

  await db
    .update(widgetChatConversations)
    .set({ updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));

  return message!;
}

/**
 * Live-coder send: staff member (identified widget user with live_coder
 * permission) sends a message into a conversation they do NOT own.
 *
 * Resolves the conversation scoped to the project (not to widgetUserId).
 * Persists as role='user' so it appears in the transcript just like a regular
 * visitor message (the caller is instructing the agent on the visitor's behalf).
 * Also returns the resolved workspace channel id (workspaceTasks.workspaceChannelId)
 * for the caller to forward via forwardLiveMessage.
 *
 * Throws WidgetError('conversation_not_found', 404) if the conversation does
 * not belong to the project. Throws WidgetError('conversation_closed', 409)
 * if the conversation is not active.
 */
export async function sendLiveCoderMessage(
  conversationId: string,
  projectId: string,
  content: string,
): Promise<{ message: ChatMessageRow; jobChannelId: string | null; canonicalTaskId: string | null }> {
  if (!UUID_RE.test(conversationId)) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  const [conv] = await db
    .select()
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.id, conversationId))
    .limit(1);
  if (!conv || conv.widgetProjectId !== projectId) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }
  // NOTE: intentionally NOT gated on conv.status === 'active'. A live-coder
  // message is a staff member steering the agent AFTER a ticket exists, and the
  // originating intake conversation is closed the moment it produces that ticket
  // (submit-ticket closes it server-side). The Live session reuses that same
  // conversation, so requiring 'active' here rejected every live-coder message
  // with conversation_closed (surfaced in the widget as "message limit reached").
  // The intake turn-cap / closed guards live on the intake send path, not here.

  const text = content.trim();
  if (!text) throw new WidgetService.WidgetError('message_required', 400);
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new WidgetService.WidgetError('message_too_long', 400);
  }

  // Resolve the job channel from the linked workspace task (if any).
  let jobChannelId: string | null = null;
  if (conv.createdTaskId) {
    const [taskRow] = await db
      .select({ workspaceChannelId: workspaceTasks.workspaceChannelId })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.id, conv.createdTaskId))
      .limit(1);
    jobChannelId = taskRow?.workspaceChannelId ?? null;
  }

  const [message] = await db
    .insert(widgetChatMessages)
    .values({ conversationId, role: 'user', content: text })
    .returning();
  publish(message!);

  await db
    .update(widgetChatConversations)
    .set({ updatedAt: new Date() })
    .where(eq(widgetChatConversations.id, conversationId));

  // The canonical task id is the stable key for the running coder job on the
  // workspace (the coder runs in its own per-job channel, not this ticket's
  // jobChannelId). conv.createdTaskId IS the canonical task id.
  return { message: message!, jobChannelId, canonicalTaskId: conv.createdTaskId ?? null };
}

// Ticket activity types worth showing INSIDE the live session as a progress
// timeline: status transitions, agent milestones (`runhq milestone` →
// agent_update), and PR lifecycle. `assigned`/`agent_assigned` are deliberately
// excluded — agent assignment already reaches the chat thread as its own
// `assigned` event (ingestTurnEvents), so mirroring them here would double up.
// Comments/edits/archive/etc. are activity-feed-only and would be noise in chat.
const LIVE_SESSION_MIRRORED_ACTIVITY = new Set([
  'status_change',
  'agent_update',   // `runhq milestone`
  'pr_linked',
  'agent_assigned',
  'agent_unassigned',
  'assigned',
  'unassigned',
]);
// Assignment activity types. When a ticket is assigned THROUGH the widget chat,
// the workspace already emits a dedicated `assigned` chat event (ingestTurnEvents)
// — so mirroring the agent_assigned/assigned ACTIVITY too would double the line.
// For these types we skip the mirror when the thread already shows an `assigned`
// event. (Auto-PR / triage assignment has no such chat event, so it still shows.)
const ASSIGNMENT_ACTIVITY = new Set(['agent_assigned', 'agent_unassigned', 'assigned', 'unassigned']);

// How far back to look when backfilling a freshly-opened live session.
const ACTIVITY_BACKFILL_LIMIT = 100;

// True when the conversation already carries the chat-native `assigned` event,
// so an assignment ACTIVITY row would be a duplicate line.
async function conversationHasAssignedEvent(conversationId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: widgetChatMessages.id })
    .from(widgetChatMessages)
    .where(and(
      eq(widgetChatMessages.conversationId, conversationId),
      eq(widgetChatMessages.role, 'event'),
      sql`${widgetChatMessages.payload}->>'kind' = 'assigned'`,
    ))
    .limit(1);
  return !!hit;
}

// Insert one activity event into a conversation, idempotently. The turn id is
// `act:<conversationId>:<activityId>` so the live forward-mirror and the
// open-time backfill of the SAME activity collide on the (turn_id, seq) unique
// index (onConflictDoNothing) — neither can produce a duplicate — while the same
// activity can still land in a sibling conversation of a multi-conversation
// ticket (different conversationId → different turn id). Returns true on insert.
async function insertActivityEvent(
  conversationId: string,
  activity: { id: string; type: string; content: string | null; metadata: Record<string, unknown> | null },
): Promise<boolean> {
  if (ASSIGNMENT_ACTIVITY.has(activity.type) && await conversationHasAssignedEvent(conversationId)) {
    return false;
  }
  const payload: WidgetChatMessagePayload = {
    kind: 'activity',
    activityType: activity.type,
    content: activity.content,
    metadata: activity.metadata,
  };
  const [row] = await db
    .insert(widgetChatMessages)
    .values({ conversationId, role: 'event', content: '', payload, turnId: `act:${conversationId}:${activity.id}`, seq: 0 })
    .onConflictDoNothing()
    .returning();
  if (row) { publish(row); return true; }
  return false;
}

/**
 * Mirror a ticket activity row into its live-session chat thread (if one
 * exists), so the live session shows the same progress timeline as the public
 * ticket screen. Persisted as a role='event' row with the source activity's
 * shape; the widget renders it through its existing describeEvent() formatter,
 * giving identical wording to the activity feed with zero duplicated copy.
 *
 * Best-effort and idempotent-by-construction: addActivity inserts exactly one
 * activity row per call, so this fires once per activity (no turnId dedup
 * needed). Only mirrors into a conversation that ALREADY exists — it never
 * creates one, so a status change on a ticket nobody opened a session on is a
 * no-op. Never throws (the caller wraps it; a mirror failure must not break the
 * activity write).
 */
export async function mirrorActivityToLiveSession(
  taskId: string,
  activity: { id: string; type: string; content?: string | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  if (!LIVE_SESSION_MIRRORED_ACTIVITY.has(activity.type)) return;

  // A ticket can be backed by more than one conversation (the intake thread that
  // created it AND a lazily-created live-session thread for a directly-assigned
  // ticket), so mirror into every conversation linked to the task.
  const convs = await db
    .select({ id: widgetChatConversations.id })
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.createdTaskId, taskId));

  for (const conv of convs) {
    await insertActivityEvent(conv.id, {
      id: activity.id,
      type: activity.type,
      content: activity.content ?? null,
      metadata: activity.metadata ?? null,
    });
  }
}

/**
 * Backfill a live session's progress timeline when it is opened. A directly-
 * assigned (auto-PR / triage) ticket has no conversation until staff open the
 * Live session, so everything that already happened — assignment, status
 * changes, milestones, PR events — predates the thread and the forward mirror
 * never saw it. This replays the ticket's recent allowlisted activity into the
 * conversation. Idempotent: each row reuses the `act:<activityId>` turn id, so
 * re-opening the session, or an event that was also live-mirrored, never
 * duplicates. Comments live in a separate table and never reach this path.
 * Best-effort; never throws.
 */
export async function backfillLiveSessionActivity(conversationId: string, taskId: string): Promise<void> {
  try {
    const rows = await db
      .select({
        id: workspaceTaskActivity.id,
        type: workspaceTaskActivity.type,
        content: workspaceTaskActivity.content,
        metadata: workspaceTaskActivity.metadata,
      })
      .from(workspaceTaskActivity)
      .where(and(
        eq(workspaceTaskActivity.taskId, taskId),
        inArray(workspaceTaskActivity.type, [...LIVE_SESSION_MIRRORED_ACTIVITY]),
      ))
      .orderBy(desc(workspaceTaskActivity.createdAt))
      .limit(ACTIVITY_BACKFILL_LIMIT);

    // Insert oldest-first so created_at order matches the original timeline.
    for (const row of rows.reverse()) {
      await insertActivityEvent(conversationId, {
        id: row.id,
        type: row.type,
        content: row.content ?? null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      });
    }
  } catch (err) {
    console.warn('[WidgetChatService] live-session activity backfill failed', err);
  }
}

/**
 * Idempotently persist a batch of turn events. Rows upsert on the partial
 * unique index (turn_id, seq) via onConflictDoNothing — retries cannot
 * duplicate, reordering cannot corrupt (rows are processed in seq order and
 * inserted one statement at a time so created_at preserves seq order for the
 * cursor/ordering scheme). Late events for a timed-out turn still land; a
 * late turn_done deletes the BE-written agent_unavailable notice.
 */
export async function ingestTurnEvents(
  serverId: string,
  input: { conversationId: string; turnId: string; events: TurnEventInput[] },
): Promise<IngestResult> {
  // Cross-tenant guard: the conversation's project must belong to the server
  // that authenticated this request.
  const [found] = await db
    .select({
      conversation: widgetChatConversations,
      projectServerId: widgetProjects.serverId,
      widgetProjectId: widgetProjects.id,
    })
    .from(widgetChatConversations)
    .innerJoin(widgetProjects, eq(widgetChatConversations.widgetProjectId, widgetProjects.id))
    .where(eq(widgetChatConversations.id, input.conversationId))
    .limit(1);
  if (!found || found.projectServerId !== serverId) {
    throw new WidgetService.WidgetError('conversation_not_found', 404);
  }

  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  let inserted = 0;
  let turnDone = false;
  let turnError = false;

  for (const ev of events) {
    if (!Number.isInteger(ev.seq) || ev.seq < 0) continue;
    if (ev.kind === 'turn_done') {
      turnDone = true;
      continue;
    }

    let row: { role: 'agent' | 'team' | 'event'; content: string; payload: WidgetChatMessagePayload | null } | null = null;
    switch (ev.kind) {
      case 'agent_message': {
        if (typeof ev.text === 'string' && ev.text.length > 0) {
          row = { role: 'agent', content: ev.text, payload: null };
        }
        break;
      }
      case 'team_message': {
        // A workspace member's live-chat message mirrored OUT to the widget live
        // session. Persisted as a `team` row so the external viewer sees what the
        // team said (the live session mirrors the workspace live chat). Not part
        // of the agent's turn transcript (buildTranscript excludes role='team').
        //
        // authorName attributes the reply to the human who sent it, so a live
        // session with MULTIPLE staff shows each sender's name rather than a
        // generic "Team" (the widget renders payload.authorName, falling back to
        // "Team" when absent). Same {authorName} payload shape as sendTeamReply.
        if (typeof ev.text === 'string' && ev.text.length > 0) {
          const authorName = typeof ev.authorName === 'string' ? ev.authorName.trim() : '';
          row = {
            role: 'team',
            content: ev.text,
            payload: authorName ? { authorName } : null,
          };
        }
        break;
      }
      case 'proposal': {
        if (typeof ev.title === 'string' && typeof ev.description === 'string' && typeof ev.toolUseId === 'string') {
          row = {
            role: 'event', content: '',
            payload: { kind: 'proposal', title: ev.title, description: ev.description, toolUseId: ev.toolUseId },
          };
        }
        break;
      }
      case 'ticket_link': {
        if (typeof ev.ticketId !== 'string' || !UUID_RE.test(ev.ticketId)) break;
        // Enrich from the synced task store, scoped to this server — a bogus
        // or cross-tenant ticketId silently drops the event. Gating on
        // visibility='public' is defense-in-depth: the workspace-side search
        // already filters private tickets, but a link card renders the title
        // to an anonymous visitor, so the gate must also hold here.
        const [task] = await db
          .select({ title: workspaceTasks.title, status: workspaceTasks.status })
          .from(workspaceTasks)
          .where(and(
            eq(workspaceTasks.id, ev.ticketId),
            eq(workspaceTasks.serverId, serverId),
            eq(workspaceTasks.visibility, 'public'),
          ))
          .limit(1);
        if (!task) {
          console.warn('[WidgetChatService] ticket_link to unknown or non-public task dropped:', ev.ticketId);
          break;
        }
        row = {
          role: 'event', content: '',
          payload: { kind: 'ticket_link', ticketId: ev.ticketId, title: task.title, status: task.status },
        };
        break;
      }
      case 'search_performed': {
        // Model-memory trace of a search_tickets call. Stored as an event row;
        // buildTranscript passes it back to the workspace, which reconstructs
        // the tool exchange so the agent does not re-search every turn. Both
        // fields required (a malformed trace is dropped, not stored empty).
        if (typeof ev.query === 'string' && ev.query.length > 0
          && typeof ev.resultText === 'string' && ev.resultText.length > 0) {
          row = { role: 'event', content: '', payload: { kind: 'search_performed', query: ev.query, resultText: ev.resultText } };
        }
        break;
      }
      case 'assigned': {
        if (typeof ev.ticketId !== 'string' || typeof ev.agentEntityId !== 'string') break;
        const [agentRow] = await db
          .select({ name: widgetExposedAgents.agentName })
          .from(widgetExposedAgents)
          .where(and(
            eq(widgetExposedAgents.widgetProjectId, found.widgetProjectId),
            eq(widgetExposedAgents.agentId, ev.agentEntityId),
          ))
          .limit(1);
        row = {
          role: 'event', content: '',
          payload: {
            kind: 'assigned', ticketId: ev.ticketId,
            agentEntityId: ev.agentEntityId, agentName: agentRow?.name ?? null,
          },
        };
        break;
      }
      case 'turn_error': {
        turnError = true;
        const text = (typeof ev.message === 'string' && ev.message ? ev.message : 'The agent hit an error.').slice(0, 500);
        row = { role: 'event', content: '', payload: { kind: 'system_notice', code: 'turn_failed', text } };
        break;
      }
    }
    if (!row) continue;

    // One statement per row (NOT a wrapping transaction): each insert gets a
    // distinct now(), so created_at order matches seq order.
    const ins = await db
      .insert(widgetChatMessages)
      .values({
        conversationId: input.conversationId,
        role: row.role,
        content: row.content,
        payload: row.payload,
        turnId: input.turnId,
        seq: ev.seq,
      })
      .onConflictDoNothing()
      .returning();
    if (ins[0]) {
      inserted++;
      publish(ins[0]);
    }
  }

  if (turnError || turnDone) {
    cancelTurnTimeout(input.turnId);
    if (turnDone) {
      // Late completion clears the timeout notice (model output is paid for —
      // the late reply rows above replace the failure state).
      await db.delete(widgetChatMessages).where(and(
        eq(widgetChatMessages.conversationId, input.conversationId),
        eq(widgetChatMessages.turnId, input.turnId),
        isNull(widgetChatMessages.seq),
        sql`${widgetChatMessages.payload}->>'kind' = 'system_notice'`,
        sql`${widgetChatMessages.payload}->>'code' = 'agent_unavailable'`,
      ));
    }
    const [current] = await db
      .select()
      .from(widgetChatConversations)
      .where(eq(widgetChatConversations.id, input.conversationId))
      .limit(1);
    if (current) {
      const updates: Partial<typeof widgetChatConversations.$inferInsert> = { updatedAt: new Date() };
      if (current.pendingTurnId === input.turnId) updates.pendingTurnId = null;
      // Contract: turn_done after a created proposal_resolved closes the
      // conversation (createdTaskId is set exactly then) — but only when the
      // finishing turn OWNS the pending slot (or the slot was already cleared
      // by the turn timeout; late completions still honor the close-on-done
      // contract). Turns run concurrently (each user message dispatches one,
      // overwriting pending_turn_id), so a STALE turn — dispatched before the
      // ticket existed and superseded by the post-create turn — can finish
      // right after creation. Letting it close the conversation made the
      // widget's closed-watch kill the SSE transport before the post-create
      // turn's assigned/wrap-up rows arrived, so the user never saw
      // "Assigned to …" (live repro 2026-06-07).
      if (turnDone && current.createdTaskId
        && (current.pendingTurnId === null || current.pendingTurnId === input.turnId)) {
        updates.status = 'closed';
      }
      await db
        .update(widgetChatConversations)
        .set(updates)
        .where(eq(widgetChatConversations.id, input.conversationId));
    }
  }

  return { inserted, turnDone };
}

// ============================================================================
// Chat image upload
// ============================================================================

/** Publicly safe image descriptor — never includes storage keys. */
export interface PublicChatImage {
  id: string;
  mimeType: string;
  originalName: string | null;
  width: number;
  height: number;
}

/**
 * Map a full ChatImageRow to the public-safe descriptor.
 * MUST NOT include storageProvider, storageKey, or any derivative storage fields.
 */
export function toPublicChatImage(row: Pick<ChatImageRow, 'id' | 'mimeType' | 'originalName' | 'width' | 'height'>): PublicChatImage {
  return {
    id: row.id,
    mimeType: row.mimeType,
    originalName: row.originalName ?? null,
    width: row.width,
    height: row.height,
  };
}

/**
 * Batch-load all widget_chat_images linked to a set of message ids.
 * Returns a Map<messageId, PublicChatImage[]> for O(1) lookup per message.
 * Empty input returns an empty Map without querying the DB.
 */
export async function loadChatImagesForMessages(
  messageIds: string[],
): Promise<Map<string, PublicChatImage[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: widgetChatImages.id,
      mimeType: widgetChatImages.mimeType,
      originalName: widgetChatImages.originalName,
      width: widgetChatImages.width,
      height: widgetChatImages.height,
      messageId: widgetChatImages.messageId,
    })
    .from(widgetChatImages)
    .where(inArray(widgetChatImages.messageId, messageIds));
  const map = new Map<string, PublicChatImage[]>();
  for (const row of rows) {
    if (!row.messageId) continue;
    const existing = map.get(row.messageId);
    if (existing) {
      existing.push(toPublicChatImage(row));
    } else {
      map.set(row.messageId, [toPublicChatImage(row)]);
    }
  }
  return map;
}

/**
 * Gate an image upload behind conversation writability + per-conversation cap,
 * then delegate storage to WidgetService.storeWidgetChatImage. Returns only
 * the public-safe fields — storage keys are never exposed to callers.
 *
 * Error codes thrown:
 *   conversation_not_found (404) — not the owner or doesn't exist
 *   conversation_closed (409)    — conversation is no longer active
 *   attachment_count_exceeded (400) — per-conversation cap reached
 *   + any errors from storeWidgetChatImage (type, size, guard, storage)
 */
export async function attachConversationImage(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  permissions: ReadonlySet<WidgetService.WidgetPermission>,
  file: WidgetService.WidgetUploadFile,
): Promise<PublicChatImage> {
  // 1. Verify conversation ownership + active status
  await requireWritableConversation(conversationId, projectId, widgetUserId);

  // 2. Fail fast before any storage: check per-conversation cap
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(widgetChatImages)
    .where(eq(widgetChatImages.conversationId, conversationId));
  if (Number(countRow?.count ?? 0) >= WidgetService.MAX_CHAT_IMAGES_PER_CONVERSATION) {
    throw new WidgetService.WidgetError('attachment_count_exceeded', 400);
  }

  // 3. Delegate type/size/guard/storage to WidgetService
  const row = await WidgetService.storeWidgetChatImage(projectId, conversationId, widgetUserId, permissions, file);

  // 4. Strip storage keys before returning
  return toPublicChatImage(row);
}

/**
 * Load a widget_chat_images row owned by the caller and return a presigned
 * download URL for the ORIGINAL rendition. Used by the GET serve endpoint.
 *
 * Throws:
 *   conversation_not_found (404) — unknown conversationId, wrong user, or wrong project.
 *   image_not_found (404)        — unknown imageId, wrong conversation, or wrong user.
 */
export async function resolveConversationImageForServe(
  conversationId: string,
  imageId: string,
  projectId: string,
  widgetUserId: string,
): Promise<string> {
  // 1. Verify conversation ownership (also asserts projectId)
  await getConversationOwned(conversationId, projectId, widgetUserId);

  // 2. Load the image row, asserting conversation + user ownership
  const [row] = await db
    .select({
      originalStorageProvider: widgetChatImages.originalStorageProvider,
      originalStorageKey: widgetChatImages.originalStorageKey,
      originalName: widgetChatImages.originalName,
    })
    .from(widgetChatImages)
    .where(
      and(
        eq(widgetChatImages.id, imageId),
        eq(widgetChatImages.conversationId, conversationId),
        eq(widgetChatImages.widgetUserId, widgetUserId),
      ),
    )
    .limit(1);

  if (!row) throw new WidgetService.WidgetError('image_not_found', 404);

  // 3. Generate presigned URL for the original rendition — short-lived (5 min)
  // because chat images are private and the URL is served directly to the user.
  const url = await attachmentStorageImpl.createDownloadUrl({
    storageProvider: row.originalStorageProvider,
    storageKey: row.originalStorageKey,
    originalName: row.originalName,
  }, { ttlSeconds: 300 });

  if (!url) throw new WidgetService.WidgetError('image_not_found', 404);

  return url;
}
