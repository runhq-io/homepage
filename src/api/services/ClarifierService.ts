/**
 * ClarifierService.ts — DB glue + orchestration for the widget ticket clarifier.
 *
 * Coordinates between clarifierCore (pure LLM logic), the DB (drizzle), and
 * the Anthropic SDK. The model call is injectable for testing without a real key.
 *
 * Exports:
 *   - CallModel        — the injectable model-call type
 *   - ClarifierStep    — the return shape for both entry points
 *   - startClarification(input, deps?) — begin a new clarification run
 *   - answerClarification(id, answers, deps?) — record answers and (if all done) advance
 */

import { db } from '../../db/index';
import {
  widgetClarifications,
  widgetClarificationQuestions,
  workspaceTasks,
} from '../../db/schema';
import { eq, and, asc } from 'drizzle-orm';
import {
  buildClarifierMessages,
  parseVerdict,
  resolveClarifierAction,
  ClarifierParseError,
  type ClarifierQuestion,
} from './clarifierCore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable model call — returns raw model text. */
export type CallModel = (args: {
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<string>;

export type ClarifierStep =
  | { status: 'ready'; clarificationId: string }
  | {
      status: 'asking';
      clarificationId: string;
      round: number;
      questions: Array<{
        id: string;
        prompt: string;
        options: string[] | null;
        multiselect: boolean;
      }>;
    };

// ---------------------------------------------------------------------------
// Default real model call (Haiku)
// ---------------------------------------------------------------------------

async function defaultCallModel(args: {
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
}): Promise<string> {
  const { getSettings } = await import('./SettingsService');
  const settings = await getSettings();
  const apiKey = settings.claudeApiKey;
  if (!apiKey) throw new Error('No claudeApiKey configured');

  const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey });
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
  args: { system: string; messages: Array<{ role: 'user'; content: string }> },
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

/** Persist question rows for the given clarificationId+round, return the stored rows. */
async function insertQuestions(
  clarificationId: string,
  questions: ClarifierQuestion[],
  round: number,
): Promise<Array<{ id: string; prompt: string; options: string[] | null; multiselect: boolean }>> {
  const inserted = await db
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
  input: {
    serverId: string;
    taskId: string;
    widgetUserId: string;
    ticket: { title: string; description: string | null };
  },
  deps?: { callModel?: CallModel },
): Promise<ClarifierStep> {
  const callModel = deps?.callModel ?? defaultCallModel;

  // 1. Insert the clarification row (round 0, status 'asking')
  const [clarRow] = await db
    .insert(widgetClarifications)
    .values({
      taskId: input.taskId,
      serverId: input.serverId,
      widgetUserId: input.widgetUserId,
      status: 'asking',
      round: 0,
    })
    .returning({ id: widgetClarifications.id });
  const clarificationId = clarRow!.id;

  // 2. Build messages and call model (with fallback handling)
  const { system, messages } = buildClarifierMessages(input.ticket, []);
  const { verdict } = await callModelWithFallback({ system, messages }, callModel);

  // 3. Resolve action
  const action = resolveClarifierAction(0, verdict);

  if (action.action === 'proceed') {
    // Mark ready
    await db
      .update(widgetClarifications)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(widgetClarifications.id, clarificationId));

    return { status: 'ready', clarificationId };
  }

  // action === 'ask': persist questions
  const questions = await insertQuestions(clarificationId, action.questions, 0);
  return { status: 'asking', clarificationId, round: 0, questions };
}

// ---------------------------------------------------------------------------
// answerClarification
// ---------------------------------------------------------------------------

export async function answerClarification(
  clarificationId: string,
  answers: Array<{ questionId: string; answer: string | string[] }>,
  deps?: { callModel?: CallModel },
): Promise<ClarifierStep> {
  const callModel = deps?.callModel ?? defaultCallModel;

  // 1. Load the clarification row
  const [clarRow] = await db
    .select()
    .from(widgetClarifications)
    .where(eq(widgetClarifications.id, clarificationId))
    .limit(1);
  if (!clarRow) throw new Error(`Clarification not found: ${clarificationId}`);

  // 2. Mark the provided questions answered (only 'pending' ones belonging to this clarification)
  const now = new Date();
  for (const { questionId, answer } of answers) {
    await db
      .update(widgetClarificationQuestions)
      .set({ status: 'answered', answer, answeredAt: now })
      .where(
        and(
          eq(widgetClarificationQuestions.id, questionId),
          eq(widgetClarificationQuestions.clarificationId, clarificationId),
          eq(widgetClarificationQuestions.status, 'pending'),
        ),
      );
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

  // 4. All answered — advance to next round
  const newRound = clarRow.round + 1;

  // Rebuild Q&A history from all answered questions for this clarification
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

  const qa = answeredRows.map((r) => ({
    question: r.prompt,
    answer: Array.isArray(r.answer) ? (r.answer as string[]).join(', ') : String(r.answer ?? ''),
  }));

  // Load the ticket title/description from workspaceTasks
  const [taskRow] = await db
    .select({ title: workspaceTasks.title, description: workspaceTasks.description })
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, clarRow.taskId))
    .limit(1);
  const ticket = { title: taskRow?.title ?? '', description: taskRow?.description ?? null };

  // 5. Call model (with fallback)
  const { system, messages } = buildClarifierMessages(ticket, qa);
  const { verdict } = await callModelWithFallback({ system, messages }, callModel);

  const action = resolveClarifierAction(newRound, verdict);

  // 6. Update clarification row
  if (action.action === 'proceed') {
    await db
      .update(widgetClarifications)
      .set({ status: 'ready', round: newRound, updatedAt: new Date() })
      .where(eq(widgetClarifications.id, clarificationId));

    return { status: 'ready', clarificationId };
  }

  // Insert new question rows for this round
  await db
    .update(widgetClarifications)
    .set({ round: newRound, updatedAt: new Date() })
    .where(eq(widgetClarifications.id, clarificationId));

  const questions = await insertQuestions(clarificationId, action.questions, newRound);
  return { status: 'asking', clarificationId, round: newRound, questions };
}
