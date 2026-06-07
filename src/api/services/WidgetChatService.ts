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
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  servers,
  widgetChatConversations,
  widgetChatMessages,
  widgetClarifications,
  widgetExposedAgents,
  widgetProjects,
  workspaceTasks,
  type WidgetChatEventPayload,
} from '../../db/schema';
import * as ServerService from './ServerService';
import * as WidgetService from './WidgetService';

export type ChatConversationRow = typeof widgetChatConversations.$inferSelect;
export type ChatMessageRow = typeof widgetChatMessages.$inferSelect;
export type { WidgetChatEventPayload };

/** Events the workspace reports back for a turn. seq orders them; turn_done completes the turn. */
export type TurnEventInput =
  | { seq: number; kind: 'agent_message'; text?: unknown }
  | { seq: number; kind: 'proposal'; title?: unknown; description?: unknown; toolUseId?: unknown }
  | { seq: number; kind: 'ticket_link'; ticketId?: unknown }
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
  widgetChatInstructions: string | null;
}

async function getChatProject(projectId: string): Promise<ChatProject | null> {
  const [project] = await db
    .select({
      id: widgetProjects.id,
      serverId: widgetProjects.serverId,
      workspaceProjectId: widgetProjects.workspaceProjectId,
      widgetChatAgentEntityId: widgetProjects.widgetChatAgentEntityId,
      widgetChatInstructions: widgetProjects.widgetChatInstructions,
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
    ))
    .orderBy(desc(widgetChatConversations.createdAt))
    .limit(1);
  return conv ?? null;
}

export interface ConversationBundle {
  conversation: ChatConversationRow;
  messages: ChatMessageRow[];
}

/**
 * Start-or-resume: the widget's "Chat with Agent" card entry point. Chat must
 * be enabled (a support agent configured in settings). Concurrent first-opens
 * can race into two active rows; findActiveConversation picks the newest and
 * the loser simply goes unused — harmless for this surface.
 */
export async function getOrCreateActiveConversation(
  projectId: string,
  widgetUserId: string,
): Promise<ConversationBundle> {
  const project = await getChatProject(projectId);
  if (!project) throw new WidgetService.WidgetError('project_not_found', 404);
  if (!project.widgetChatAgentEntityId) {
    throw new WidgetService.WidgetError('chat_not_enabled', 404);
  }
  const existing = await findActiveConversation(projectId, widgetUserId);
  if (existing) {
    return { conversation: existing, messages: await loadRecentMessages(existing.id) };
  }
  const [conversation] = await db
    .insert(widgetChatConversations)
    .values({ widgetProjectId: projectId, widgetUserId })
    .returning();
  return { conversation: conversation!, messages: [] };
}

export async function getActiveConversation(
  projectId: string,
  widgetUserId: string,
): Promise<ConversationBundle | null> {
  const conv = await findActiveConversation(projectId, widgetUserId);
  if (!conv) return null;
  return { conversation: conv, messages: await loadRecentMessages(conv.id) };
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
  after?: string,
): Promise<ChatMessageRow[]> {
  await getConversationOwned(conversationId, projectId, widgetUserId);
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

export type TranscriptEntry =
  | { role: 'user' | 'agent'; content: string }
  | { role: 'event'; payload: WidgetChatEventPayload };

/**
 * Map persisted rows onto the turn-dispatch transcript shape. Defensive:
 * payload-less event rows and empty user/agent rows are dropped.
 */
export function buildTranscript(
  rows: Pick<ChatMessageRow, 'role' | 'content' | 'payload'>[],
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const row of rows) {
    if (row.role === 'event') {
      if (row.payload) out.push({ role: 'event', payload: row.payload });
    } else if (row.content) {
      out.push({ role: row.role, content: row.content });
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
    if (!p) continue;
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
        chatInstructions: project.widgetChatInstructions,
        forceProposal: opts.forceProposal === true,
        transcript: buildTranscript(rows),
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
 * Append a user message and trigger a turn. Caps: 4000 chars per message,
 * 30 user turns per conversation (abuse backstop — each turn is paid model
 * time). The HTTP layer additionally rate-limits via the chat_message bucket.
 */
export async function sendUserMessage(
  conversationId: string,
  projectId: string,
  widgetUserId: string,
  content: string,
): Promise<ChatMessageRow> {
  const text = content.trim();
  if (!text) throw new WidgetService.WidgetError('message_required', 400);
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new WidgetService.WidgetError('message_too_long', 400);
  }

  const conversation = await requireWritableConversation(conversationId, projectId, widgetUserId);
  if (conversation.userTurnCount >= MAX_USER_TURNS) {
    throw new WidgetService.WidgetError('turn_limit_reached', 409);
  }

  const [message] = await db
    .insert(widgetChatMessages)
    .values({ conversationId, role: 'user', content: text })
    .returning();
  publish(message!);

  await db
    .update(widgetChatConversations)
    .set({
      userTurnCount: sql`${widgetChatConversations.userTurnCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(widgetChatConversations.id, conversationId));

  await dispatchTurn(conversation);
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

  // Post-creation turn: computePendingProposal now derives
  // {created:true, ticketId} from the row just written.
  await dispatchTurn({ ...fresh, createdTaskId: task.id });

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

    let row: { role: 'agent' | 'event'; content: string; payload: WidgetChatEventPayload | null } | null = null;
    switch (ev.kind) {
      case 'agent_message': {
        if (typeof ev.text === 'string' && ev.text.length > 0) {
          row = { role: 'agent', content: ev.text, payload: null };
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
        // or cross-tenant ticketId silently drops the event.
        const [task] = await db
          .select({ title: workspaceTasks.title, status: workspaceTasks.status })
          .from(workspaceTasks)
          .where(and(eq(workspaceTasks.id, ev.ticketId), eq(workspaceTasks.serverId, serverId)))
          .limit(1);
        if (!task) {
          console.warn('[WidgetChatService] ticket_link to unknown task dropped:', ev.ticketId);
          break;
        }
        row = {
          role: 'event', content: '',
          payload: { kind: 'ticket_link', ticketId: ev.ticketId, title: task.title, status: task.status },
        };
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
