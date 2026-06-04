/**
 * clarifierCore.ts — Pure, dependency-free core for the widget ticket clarifier.
 *
 * No I/O, no DB, no Anthropic SDK imports. All functions are deterministic and
 * unit-testable without any environment setup.
 *
 * Lifecycle (caller is responsible for the loop):
 *   1. Call buildClarifierMessages() → send to Haiku → get text back.
 *   2. Call parseVerdict(text) → ClarifierVerdict.
 *   3. Call resolveClarifierAction(round, verdict) → 'ask' | 'proceed'.
 *   4. If 'ask': surface questions to the user, collect answers, increment round, go to 1.
 *   5. If 'proceed': mark ticket ready and continue to assignment.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClarifierQuestion {
  prompt: string;
  options?: string[];      // optional multiple-choice options
  multiselect?: boolean;   // default false; only meaningful when options is set
}

export type ClarifierVerdict =
  | { ready: true }
  | { ready: false; questions: ClarifierQuestion[] };

/** Maximum number of clarification rounds before we force-proceed. */
export const MAX_CLARIFICATION_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClarifierParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClarifierParseError';
  }
}

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

/**
 * Parse the model's text output into a ClarifierVerdict.
 *
 * Extracts the first JSON object found in `text` (so the model can wrap it in
 * prose without breaking parsing), validates the shape, and returns the typed
 * verdict.
 *
 * Shape rules:
 *   - `ready: true`  → valid, no other keys required.
 *   - `ready: false` → MUST include a non-empty `questions` array where every
 *                      element has a non-empty string `prompt`.
 *
 * Throws ClarifierParseError on any malformed or invalid input.
 */
export function parseVerdict(text: string): ClarifierVerdict {
  // Extract the first {...} block from the text (handles prose wrapping).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new ClarifierParseError(
      `No JSON object found in model output. Raw text: ${text.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new ClarifierParseError(
      `Failed to parse JSON from model output: ${(err as Error).message}. Raw: ${jsonMatch[0].slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClarifierParseError('Parsed JSON is not an object.');
  }

  const obj = parsed as Record<string, unknown>;

  if (!('ready' in obj) || typeof obj['ready'] !== 'boolean') {
    throw new ClarifierParseError(
      '`ready` key is missing or not a boolean in model output.',
    );
  }

  if (obj['ready'] === true) {
    return { ready: true };
  }

  // ready === false: validate questions
  if (!('questions' in obj) || !Array.isArray(obj['questions'])) {
    throw new ClarifierParseError(
      '`ready:false` verdict must include a `questions` array.',
    );
  }

  const rawQuestions = obj['questions'] as unknown[];

  if (rawQuestions.length === 0) {
    throw new ClarifierParseError(
      '`ready:false` verdict must include at least one question (empty array is invalid).',
    );
  }

  const questions: ClarifierQuestion[] = rawQuestions.map((q, idx) => {
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      throw new ClarifierParseError(`questions[${idx}] is not an object.`);
    }
    const qObj = q as Record<string, unknown>;

    if (typeof qObj['prompt'] !== 'string' || qObj['prompt'].trim() === '') {
      throw new ClarifierParseError(
        `questions[${idx}].prompt must be a non-empty string.`,
      );
    }

    const question: ClarifierQuestion = { prompt: qObj['prompt'] };

    if ('options' in qObj) {
      if (!Array.isArray(qObj['options'])) {
        throw new ClarifierParseError(`questions[${idx}].options must be an array if present.`);
      }
      question.options = qObj['options'] as string[];
    }

    if ('multiselect' in qObj) {
      if (typeof qObj['multiselect'] !== 'boolean') {
        throw new ClarifierParseError(`questions[${idx}].multiselect must be a boolean if present.`);
      }
      question.multiselect = qObj['multiselect'];
    }

    return question;
  });

  return { ready: false, questions };
}

// ---------------------------------------------------------------------------
// resolveClarifierAction
// ---------------------------------------------------------------------------

/**
 * Decide whether to ask another round of questions or proceed to assignment.
 *
 * @param round  Number of clarification rounds already completed (0-based).
 *               At round === MAX_CLARIFICATION_ROUNDS we force-proceed even if
 *               the model still wants to ask more.
 * @param verdict The verdict returned by parseVerdict() for this round.
 */
export function resolveClarifierAction(
  round: number,
  verdict: ClarifierVerdict,
): { action: 'proceed'; reason: 'ready' | 'max_rounds' } | { action: 'ask'; questions: ClarifierQuestion[] } {
  if (verdict.ready) {
    return { action: 'proceed', reason: 'ready' };
  }

  if (round >= MAX_CLARIFICATION_ROUNDS) {
    return { action: 'proceed', reason: 'max_rounds' };
  }

  return { action: 'ask', questions: verdict.questions };
}

// ---------------------------------------------------------------------------
// buildClarifierMessages
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a requirements analyst for a software support ticket system. Your role is to decide \
whether a ticket has enough information for an engineer to begin work, or whether requirements-level \
clarifying questions are needed first.

RULES:
- Ask ONLY requirements-level questions (what, why, who, when, scope, acceptance criteria).
- Do NOT ask about implementation details, technology choices, or code-level concerns.
- Ask only what is genuinely necessary — prefer fewer, higher-value questions.
- If the ticket is already clear enough to act on, mark it ready immediately.

OUTPUT FORMAT:
You MUST output ONLY a single JSON object — no prose, no markdown, no code fences. \
The object must be one of these two shapes:

  {"ready": true}

  {"ready": false, "questions": [{"prompt": "Question text", "options": ["opt1", "opt2"], "multiselect": false}]}

The "options" and "multiselect" fields are optional. Include "options" only when the answer is \
best expressed as a fixed set of choices. Set "multiselect":true only when multiple selections \
are valid.`;

/**
 * Build the system prompt and user message(s) for a single Haiku verdict call.
 *
 * Returns a `{ system, messages }` shape compatible with the Anthropic Messages
 * API (minus the SDK import — the caller imports the SDK and passes these in).
 *
 * @param ticket  The ticket being triaged.
 * @param qa      Prior Q&A rounds (question asked → user's answer). Empty on round 0.
 */
export function buildClarifierMessages(
  ticket: { title: string; description: string | null },
  qa: Array<{ question: string; answer: string }>,
): { system: string; messages: Array<{ role: 'user'; content: string }> } {
  const lines: string[] = [];

  lines.push('## Ticket');
  lines.push(`Title: ${ticket.title}`);
  lines.push(`Description: ${ticket.description ?? '(none provided)'}`);

  if (qa.length > 0) {
    lines.push('');
    lines.push('## Prior clarification rounds');
    qa.forEach(({ question, answer }, i) => {
      lines.push(`Round ${i + 1}:`);
      lines.push(`  Q: ${question}`);
      lines.push(`  A: ${answer}`);
    });
  }

  lines.push('');
  lines.push(
    'Based on the ticket above (and prior answers, if any), output your verdict as a JSON object.',
  );

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
  };
}
