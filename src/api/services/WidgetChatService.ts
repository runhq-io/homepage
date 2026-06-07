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
