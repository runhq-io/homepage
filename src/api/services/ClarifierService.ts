/**
 * ClarifierService.ts — DB glue + orchestration for the widget ticket clarifier.
 *
 * Coordinates between clarifierCore (pure LLM logic), the DB (drizzle), and
 * the Anthropic SDK. The model call is injectable for testing without a real key.
 *
 * Exports:
 *   - CallModel           — the injectable model-call type
 *   - ClarifierStep       — the return shape for both entry points
 *   - ClarifierAnswerError — thrown when provided questionIds don't match pending questions
 *   - startClarification(input, deps?) — begin a new clarification run
 *   - answerClarification(id, answers, deps?) — record answers and (if all done) advance
 *   - getOwnedClarification(id, scope) — load a clarification gated by taskId+widgetUserId ownership
 *   - markClarificationStarted(id) — set status='started', updatedAt=now
 */

import { db } from '../../db/index';
import {
  widgetClarifications,
  widgetClarificationQuestions,
  widgetChatConversations,
  widgetChatMessages,
  workspaceTasks,
  type WidgetClarification,
} from '../../db/schema';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import {
  buildClarifierMessages,
  parseVerdict,
  resolveClarifierAction,
  extractIntakeQa,
  ClarifierParseError,
  type ClarifierQuestion,
} from './clarifierCore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single clarification question as exposed to callers (WidgetService and
 * the route layer). Declared once here to avoid duplicating the shape in
 * every return type annotation.
 */
export interface ClarificationQuestion {
  id: string;
  prompt: string;
  options: string[] | null;
  multiselect: boolean;
}

/** Injectable model call — returns raw model text. */
export type CallModel = (args: {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}) => Promise<string>;

export type ClarifierStep =
  | { status: 'ready'; clarificationId: string }
  | {
      status: 'asking';
      clarificationId: string;
      round: number;
      questions: ClarificationQuestion[];
    };

/** Input to startClarification. */
export interface StartClarificationInput {
  serverId: string;
  taskId: string;
  widgetUserId: string;
  ticket: { title: string; description: string | null };
  agentId: string;
  command: string;
}

/**
 * Thrown by answerClarification when one or more provided questionIds do not
 * match a pending question of the given clarification.
 *
 * Route layer should map this to HTTP 400.
 */
export class ClarifierAnswerError extends Error {
  constructor(message = 'one or more answers did not match a pending question') {
    super(message);
    this.name = 'ClarifierAnswerError';
  }
}

// ---------------------------------------------------------------------------
// Inline model-call bounds (shared with DedupService)
// ---------------------------------------------------------------------------

/**
 * The clarifier and dedup Haiku calls run *synchronously inside* the widget
 * `POST /api/widget/tickets/:id/{assign,clarify-answer}` HTTP handlers, which
 * sit behind Cloudflare's ~100s origin-timeout window. The Anthropic SDK
 * otherwise defaults to a 10-minute request timeout with 2 retries — so a
 * single slow or overloaded model call hangs the request until the gateway
 * gives up and returns an opaque 504 (with no application error to diagnose).
 *
 * Bounding each call well under the gateway window means transient Anthropic
 * slowness surfaces as a fast, retryable `clarifier_unavailable` (503) — or a
 * fail-open dedup — instead of a 504. Worst-case inline budget on the assign
 * path is up to two clarifier calls (parse retry) + one dedup call, i.e.
 * 3 × (MODEL_CALL_MAX_RETRIES + 1) × MODEL_CALL_TIMEOUT_MS, kept under 100s.
 */
export const MODEL_CALL_TIMEOUT_MS = 15_000;
export const MODEL_CALL_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Default real model call (Haiku)
// ---------------------------------------------------------------------------

async function defaultCallModel(args: {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<string> {
  const { getSettings } = await import('./SettingsService');
  const settings = await getSettings();
  const apiKey = settings.claudeApiKey;
  if (!apiKey) throw new Error('No claudeApiKey configured');

  const anthropic = new (await import('@anthropic-ai/sdk')).default({
    apiKey,
    timeout: MODEL_CALL_TIMEOUT_MS,
    maxRetries: MODEL_CALL_MAX_RETRIES,
  });
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: args.system,
    messages: args.messages,
  });
  const t = resp.content.find((b) => b.type === 'text');
  if (!t || t.type !== 'text') throw new Error('No text block in model response');
  return t.text;
}

// ---------------------------------------------------------------------------
// Intake Q&A (prior conversation context)
// ---------------------------------------------------------------------------

/**
 * Injectable loader for the intake Q&A of a ticket's originating widget-chat
 * conversation. Returns [] when the ticket was not created from a chat
 * conversation, or the conversation had no agent turns (agentless intake).
 */
export type LoadIntakeQa = (taskId: string) => Promise<Array<{ question: string; answer: string }>>;

/**
 * Real DB implementation: resolve the conversation that created this ticket
 * (widget_chat_conversations.created_task_id), load its transcript in order,
 * and collapse it into Q&A pairs the clarifier can read. Feeding this to the
 * clarifier is what stops an assignment from re-asking what intake covered.
 */
export const defaultLoadIntakeQa: LoadIntakeQa = async (taskId) => {
  const [conv] = await db
    .select({ id: widgetChatConversations.id })
    .from(widgetChatConversations)
    .where(eq(widgetChatConversations.createdTaskId, taskId))
    .limit(1);
  if (!conv) return [];

  const rows = await db
    .select({ role: widgetChatMessages.role, content: widgetChatMessages.content })
    .from(widgetChatMessages)
    .where(eq(widgetChatMessages.conversationId, conv.id))
    .orderBy(asc(widgetChatMessages.createdAt));

  return extractIntakeQa(rows);
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const FALLBACK_QUESTION: ClarifierQuestion = {
  prompt: 'Could you describe the expected behavior and any specific details the developer should know?',
};

/**
 * Call the model with one retry on ClarifierParseError.
 * If both attempts fail to parse, fall back to the generic question.
 */
async function callModelWithFallback(
  args: { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> },
  callModel: CallModel,
): Promise<{ verdict: Awaited<ReturnType<typeof parseVerdict>>; usedFallback: boolean }> {
  // First attempt
  const text1 = await callModel(args);
  try {
    const verdict = parseVerdict(text1);
    return { verdict, usedFallback: false };
  } catch (err) {
    if (!(err instanceof ClarifierParseError)) throw err;
    // Retry once
    const text2 = await callModel(args);
    try {
      const verdict = parseVerdict(text2);
      return { verdict, usedFallback: false };
    } catch (err2) {
      if (!(err2 instanceof ClarifierParseError)) throw err2;
      // Both failed: degrade to fallback question
      return {
        verdict: { ready: false, questions: [FALLBACK_QUESTION] },
        usedFallback: true,
      };
    }
  }
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Persist question rows for the given clarificationId+round, return the stored rows. */
async function insertQuestions(
  dbOrTx: DbOrTx,
  clarificationId: string,
  questions: ClarifierQuestion[],
  round: number,
): Promise<ClarificationQuestion[]> {
  const inserted = await dbOrTx
    .insert(widgetClarificationQuestions)
    .values(
      questions.map((q) => ({
        clarificationId,
        prompt: q.prompt,
        options: q.options ?? null,
        multiselect: q.multiselect ?? false,
        round,
        status: 'pending' as const,
      })),
    )
    .returning({
      id: widgetClarificationQuestions.id,
      prompt: widgetClarificationQuestions.prompt,
      options: widgetClarificationQuestions.options,
      multiselect: widgetClarificationQuestions.multiselect,
    });
  return inserted.map((r) => ({
    id: r.id,
    prompt: r.prompt,
    options: r.options ?? null,
    multiselect: r.multiselect,
  }));
}

// ---------------------------------------------------------------------------
// startClarification
// ---------------------------------------------------------------------------

export async function startClarification(
  input: StartClarificationInput,
  deps?: { callModel?: CallModel; loadIntakeQa?: LoadIntakeQa },
): Promise<ClarifierStep> {
  const callModel = deps?.callModel ?? defaultCallModel;
  const loadIntakeQa = deps?.loadIntakeQa ?? defaultLoadIntakeQa;

  // Prior conversation Q&A (from the chat intake that created this ticket) is
  // fed to the clarifier so an already-clarified ticket resolves to 'ready'
  // instead of being re-interrogated from scratch.
  const intakeQa = await loadIntakeQa(input.taskId);

  // 1. Call model FIRST — if this throws (non-parse error) no DB row is written.
  const { system, messages } = buildClarifierMessages(input.ticket, intakeQa);
  const { verdict } = await callModelWithFallback({ system, messages }, callModel);

  // 2. Resolve action before touching the DB
  const action = resolveClarifierAction(0, verdict);

  // 3. Write atomically: insert clarification row + questions (if asking) in one tx.
  const result = await db.transaction(async (tx) => {
    const [clarRow] = await tx
      .insert(widgetClarifications)
      .values({
        taskId: input.taskId,
        serverId: input.serverId,
        widgetUserId: input.widgetUserId,
        agentId: input.agentId,
        command: input.command,
        status: action.action === 'proceed' ? 'ready' : 'asking',
        round: 0,
      })
      .returning({ id: widgetClarifications.id });
    const clarificationId = clarRow!.id;

    if (action.action === 'proceed') {
      return { status: 'ready' as const, clarificationId };
    }

    // action === 'ask': insert question rows inside the same tx
    const questions = await insertQuestions(tx, clarificationId, action.questions, 0);
    return { status: 'asking' as const, clarificationId, round: 0 as const, questions };
  });

  return result;
}

// ---------------------------------------------------------------------------
// answerClarification
// ---------------------------------------------------------------------------

export async function answerClarification(
  clarificationId: string,
  answers: Array<{ questionId: string; answer: string | string[] }>,
  deps?: { callModel?: CallModel; loadIntakeQa?: LoadIntakeQa },
): Promise<ClarifierStep> {
  const callModel = deps?.callModel ?? defaultCallModel;
  const loadIntakeQa = deps?.loadIntakeQa ?? defaultLoadIntakeQa;

  // 1. Load the clarification row
  const [clarRow] = await db
    .select()
    .from(widgetClarifications)
    .where(eq(widgetClarifications.id, clarificationId))
    .limit(1);
  if (!clarRow) throw new Error(`Clarification not found: ${clarificationId}`);

  // 2. Mark the provided questions answered (only 'pending' ones belonging to this clarification).
  //    Use .returning() to count how many rows were actually updated.
  const now = new Date();
  let totalApplied = 0;
  for (const { questionId, answer } of answers) {
    const updated = await db
      .update(widgetClarificationQuestions)
      .set({ status: 'answered', answer, answeredAt: now })
      .where(
        and(
          eq(widgetClarificationQuestions.id, questionId),
          eq(widgetClarificationQuestions.clarificationId, clarificationId),
          eq(widgetClarificationQuestions.status, 'pending'),
        ),
      )
      .returning({ id: widgetClarificationQuestions.id });
    totalApplied += updated.length;
  }

  // 2b. If any provided IDs didn't match a pending question of this clarification, reject.
  if (totalApplied < answers.length) {
    throw new ClarifierAnswerError();
  }

  // 3. Check if any 'pending' questions remain
  const pendingRows = await db
    .select({
      id: widgetClarificationQuestions.id,
      prompt: widgetClarificationQuestions.prompt,
      options: widgetClarificationQuestions.options,
      multiselect: widgetClarificationQuestions.multiselect,
    })
    .from(widgetClarificationQuestions)
    .where(
      and(
        eq(widgetClarificationQuestions.clarificationId, clarificationId),
        eq(widgetClarificationQuestions.status, 'pending'),
      ),
    );

  if (pendingRows.length > 0) {
    // Still waiting — do NOT advance round, do NOT call model
    return {
      status: 'asking',
      clarificationId,
      round: clarRow.round,
      questions: pendingRows.map((r) => ({
        id: r.id,
        prompt: r.prompt,
        options: r.options ?? null,
        multiselect: r.multiselect,
      })),
    };
  }

  // 4. All answered — advance to next round.

  // Rebuild Q&A history from all answered questions for this clarification.
  const answeredRows = await db
    .select({
      prompt: widgetClarificationQuestions.prompt,
      answer: widgetClarificationQuestions.answer,
      createdAt: widgetClarificationQuestions.createdAt,
    })
    .from(widgetClarificationQuestions)
    .where(
      and(
        eq(widgetClarificationQuestions.clarificationId, clarificationId),
        eq(widgetClarificationQuestions.status, 'answered'),
      ),
    )
    .orderBy(asc(widgetClarificationQuestions.createdAt));

  const answeredQa = answeredRows.map((r) => ({
    question: r.prompt,
    answer: Array.isArray(r.answer) ? (r.answer as string[]).join(', ') : String(r.answer ?? ''),
  }));

  // Prepend the intake conversation Q&A so later rounds keep the full context
  // the chat agent already gathered (mirrors startClarification).
  const intakeQa = await loadIntakeQa(clarRow.taskId);
  const qa = [...intakeQa, ...answeredQa];

  // Load the ticket title/description from workspaceTasks
  const [taskRow] = await db
    .select({ title: workspaceTasks.title, description: workspaceTasks.description })
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, clarRow.taskId))
    .limit(1);
  const ticket = { title: taskRow?.title ?? '', description: taskRow?.description ?? null };

  // 5. Call model OUTSIDE the transaction (avoid holding tx open during network I/O).
  const { system, messages } = buildClarifierMessages(ticket, qa);
  const { verdict } = await callModelWithFallback({ system, messages }, callModel);

  const newRound = clarRow.round + 1;
  const action = resolveClarifierAction(newRound, verdict);

  // 6. Atomically update clarification row + insert next question rows (if asking).
  const result = await db.transaction(async (tx) => {
    if (action.action === 'proceed') {
      await tx
        .update(widgetClarifications)
        .set({ status: 'ready', round: newRound, updatedAt: new Date() })
        .where(eq(widgetClarifications.id, clarificationId));

      return { status: 'ready' as const, clarificationId };
    }

    // action === 'ask': update round + insert new question rows
    await tx
      .update(widgetClarifications)
      .set({ round: newRound, updatedAt: new Date() })
      .where(eq(widgetClarifications.id, clarificationId));

    const questions = await insertQuestions(tx, clarificationId, action.questions, newRound);
    return { status: 'asking' as const, clarificationId, round: newRound, questions };
  });

  return result;
}

// ---------------------------------------------------------------------------
// getOwnedClarification
// ---------------------------------------------------------------------------

/**
 * Load a clarification by id, but only return it when the caller owns it.
 *
 * Ownership is enforced via:
 *   - taskId   — the clarification must belong to this ticket
 *   - widgetUserId — the clarification must have been initiated by this user
 *
 * An optional serverId is applied as an extra guard when provided.
 *
 * Returns null when not found or when ownership does not match — the caller
 * should respond with 404 (intentionally non-distinguishable from not found).
 */
export async function getOwnedClarification(
  clarificationId: string,
  scope: { serverId?: string; taskId: string; widgetUserId: string },
): Promise<WidgetClarification | null> {
  const conditions = [
    eq(widgetClarifications.id, clarificationId),
    eq(widgetClarifications.taskId, scope.taskId),
    eq(widgetClarifications.widgetUserId, scope.widgetUserId),
  ];
  if (scope.serverId) {
    conditions.push(eq(widgetClarifications.serverId, scope.serverId));
  }

  const [row] = await db
    .select()
    .from(widgetClarifications)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// markClarificationStarted
// ---------------------------------------------------------------------------

/**
 * Transition a clarification to 'started' after the job has been successfully
 * enqueued via assignAgent.
 *
 * Idempotent: calling this more than once on the same row is harmless (the
 * status column is just text, and updatedAt will be refreshed).
 */
export async function markClarificationStarted(clarificationId: string): Promise<void> {
  await db
    .update(widgetClarifications)
    .set({ status: 'started', updatedAt: new Date() })
    .where(eq(widgetClarifications.id, clarificationId));
}

// ---------------------------------------------------------------------------
// markDuplicate
// ---------------------------------------------------------------------------

/**
 * Transition a clarification to 'duplicate' status, recording which existing
 * ticket it duplicates. Called by the ready-finalize gate when the dedup check
 * detects a likely duplicate.
 *
 * Idempotent: calling more than once on the same row refreshes updatedAt only.
 */
export async function markDuplicate(
  clarificationId: string,
  duplicateOfTaskId: string,
): Promise<void> {
  await db
    .update(widgetClarifications)
    .set({ status: 'duplicate', duplicateOfTaskId, updatedAt: new Date() })
    .where(eq(widgetClarifications.id, clarificationId));
}

// ---------------------------------------------------------------------------
// getAnsweredQa — Q&A export for workspace seeding
// ---------------------------------------------------------------------------

/**
 * Return all answered questions for a clarification, ordered by creation time.
 *
 * The returned shape matches the `clarification.qa` payload accepted by the
 * workspace route `POST /api/internal/widget-triager-assign`. Only
 * `status='answered'` rows are included; pending questions are excluded.
 *
 * Array answers (multiselect) are joined with ', ' to produce a single string,
 * consistent with the Q&A rebuild logic in `answerClarification`.
 */
export async function getAnsweredQa(
  clarificationId: string,
): Promise<Array<{ question: string; answer: string }>> {
  const answeredRows = await db
    .select({
      prompt: widgetClarificationQuestions.prompt,
      answer: widgetClarificationQuestions.answer,
      createdAt: widgetClarificationQuestions.createdAt,
    })
    .from(widgetClarificationQuestions)
    .where(
      and(
        eq(widgetClarificationQuestions.clarificationId, clarificationId),
        eq(widgetClarificationQuestions.status, 'answered'),
      ),
    )
    .orderBy(asc(widgetClarificationQuestions.createdAt));

  return answeredRows.map((r) => ({
    question: r.prompt,
    answer: Array.isArray(r.answer) ? (r.answer as string[]).join(', ') : String(r.answer ?? ''),
  }));
}

// ---------------------------------------------------------------------------
// Read helpers (used by WidgetService to surface clarification in ticket detail)
// ---------------------------------------------------------------------------

/**
 * Return the most recent clarification for a ticket (by taskId), or null if
 * none exists.  If multiple clarification rows ever accumulate (e.g. duplicate
 * attempts), only the latest is surfaced — callers never need to iterate.
 */
export async function getTicketClarification(taskId: string): Promise<WidgetClarification | null> {
  const [row] = await db
    .select()
    .from(widgetClarifications)
    .where(eq(widgetClarifications.taskId, taskId))
    .orderBy(
      sql`CASE WHEN ${widgetClarifications.status} IN ('duplicate','skipped') THEN 1 ELSE 0 END ASC`,
      desc(widgetClarifications.createdAt),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Return the pending (unanswered) questions for a clarification, in creation
 * order.  Only 'pending' rows are returned — answered questions are intentionally
 * excluded so callers get exactly the set the widget user still needs to act on.
 */
export async function listOpenQuestions(
  clarificationId: string,
): Promise<ClarificationQuestion[]> {
  const rows = await db
    .select({
      id: widgetClarificationQuestions.id,
      prompt: widgetClarificationQuestions.prompt,
      options: widgetClarificationQuestions.options,
      multiselect: widgetClarificationQuestions.multiselect,
    })
    .from(widgetClarificationQuestions)
    .where(
      and(
        eq(widgetClarificationQuestions.clarificationId, clarificationId),
        eq(widgetClarificationQuestions.status, 'pending'),
      ),
    )
    .orderBy(asc(widgetClarificationQuestions.createdAt));

  return rows.map((r) => ({
    id: r.id,
    prompt: r.prompt,
    options: r.options ?? null,
    multiselect: r.multiselect,
  }));
}
