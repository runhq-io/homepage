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

/**
 * Maximum number of clarification rounds before we force-proceed.
 *
 * ONE round: a thin ticket gets a single batch of questions; once the reporter
 * answers, the coding agent starts regardless. The gate exists only to unblock
 * the agent, not to interrogate the reporter — so it must never loop.
 */
export const MAX_CLARIFICATION_ROUNDS = 1;

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
  // Greedy match from first `{` to last `}` in the text (handles prose wrapping).
  // NOTE: trailing prose that itself contains `}` would extend the match and
  // cause a parse failure — acceptable because the system prompt forbids prose.
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
      if (!(qObj['options'] as unknown[]).every((el) => typeof el === 'string')) {
        throw new ClarifierParseError(`questions[${idx}].options must be an array of strings.`);
      }
      question.options = qObj['options'] as string[];
    }

    if ('multiselect' in qObj && qObj['multiselect'] === true && !('options' in qObj)) {
      throw new ClarifierParseError(`questions[${idx}].multiselect requires options.`);
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
 * @param round  0-based index of the current round (0 = first round, no prior Q&A).
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
You are the final gate before an AUTONOMOUS CODING AGENT picks up this ticket, implements it \
end-to-end, and opens a pull request — with no further contact with the reporter.

Your ONLY job: decide whether the ticket already gives that coding agent enough to ship a correct \
PR WITHOUT getting blocked. Bias STRONGLY toward "ready" — a capable engineer fills in normal \
product and implementation decisions themselves. When in doubt, mark ready.

Mark NOT ready ONLY when a critical piece is missing that would genuinely stop the agent, e.g.:
- (bug) there is no way to tell what is broken, how to reproduce it, or what the correct behavior should be.
- (feature / change) the core ask is too vague to know WHAT to build or WHERE — e.g. "hi", "make it better", "fix the thing".
- a real ambiguity where building the wrong interpretation is both likely and costly.

Do NOT ask about:
- implementation details, technology / library / architecture choices, or which files to touch — the agent decides those.
- nice-to-have polish, minor edge cases the agent can reasonably handle, or anything you could sensibly assume.

If (and only if) you must ask, ask the FEWEST questions possible (1-3) — just enough to unblock the \
agent — phrased plainly for a non-technical reporter. Otherwise mark ready.

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

// ---------------------------------------------------------------------------
// extractIntakeQa
// ---------------------------------------------------------------------------

/** A single chat transcript row, as far as Q&A extraction is concerned. */
export interface IntakeMessage {
  role: 'user' | 'agent' | string;
  content: string | null;
}

/**
 * Collapse an intake chat transcript into the `{question, answer}` pairs the
 * clarifier consumes, so an assignment never re-asks what the intake agent
 * already covered.
 *
 * Pairing rules:
 *   - Only 'agent' (the question) and 'user' (the answer) rows with non-empty
 *     content participate; 'event'/'team'/blank rows are ignored.
 *   - Consecutive agent messages accumulate into one question (the agent asked
 *     several things before the user replied).
 *   - Consecutive user replies to a pending question accumulate into one answer.
 *   - Leading user messages with no preceding agent question are skipped — they
 *     are the visitor's initial problem statement, which already lives in the
 *     ticket description.
 *   - A trailing agent question with no answer is dropped (nothing to send).
 *
 * Pure and deterministic — no I/O.
 */
export function extractIntakeQa(
  messages: IntakeMessage[],
): Array<{ question: string; answer: string }> {
  const qa: Array<{ question: string; answer: string }> = [];
  let question: string | null = null;
  let answer: string[] = [];

  const flush = () => {
    if (question !== null && answer.length > 0) {
      qa.push({ question, answer: answer.join('\n') });
    }
    question = null;
    answer = [];
  };

  for (const m of messages) {
    const content = (m.content ?? '').trim();
    if (!content) continue;
    if (m.role === 'agent') {
      // A new agent turn after a completed answer closes the prior pair.
      if (answer.length > 0) flush();
      question = question ? question + '\n' + content : content;
    } else if (m.role === 'user') {
      if (question !== null) answer.push(content);
      // else: leading problem statement — already captured in the description.
    }
  }
  flush();

  return qa;
}
