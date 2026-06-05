/**
 * dedupCore.ts — Pure, dependency-free core for LLM-based duplicate ticket detection.
 *
 * No I/O, no DB, no Anthropic SDK imports. All functions are deterministic and
 * unit-testable without any environment setup.
 *
 * Mirror of clarifierCore.ts pattern: pure prompt building + verdict parsing.
 *
 * The dedup check is advisory-only and conservative: only flag clear duplicates.
 * On any parse or model failure, callers should fail-open (treat as no duplicate).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DedupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DedupParseError';
  }
}

// ---------------------------------------------------------------------------
// buildDedupMessages
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are a duplicate-ticket detector for a software support ticket system. Given a new ticket request \
and a list of existing open tickets, decide whether the new request is essentially the SAME as one \
of the existing tickets.

RULES:
- Only flag a duplicate if the tickets describe the SAME root problem or feature request. \
  Similar topics are NOT enough — the core ask must match.
- Be CONSERVATIVE: when in doubt, return null (not a duplicate).
- Consider both the title and description. A match on title alone (when descriptions differ) is \
  insufficient to declare a duplicate.
- Ignore stylistic differences, phrasing variations, or minor wording changes.

OUTPUT FORMAT:
You MUST output ONLY a single JSON object — no prose, no markdown, no code fences.
The object must be one of these two shapes:

  {"duplicateOf": "<id>"}

  {"duplicateOf": null}

where <id> is the exact id string from the existing tickets list, or null if no duplicate was found.`;

/**
 * Build the system prompt and user message for a single Haiku dedup verdict call.
 *
 * @param candidate  The new ticket being checked.
 * @param existing   Recent open tickets to compare against (id + title + optional description).
 */
export function buildDedupMessages(
  candidate: { title: string; description?: string | null },
  existing: Array<{ id: string; title: string; description?: string | null }>,
): {
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
} {
  const lines: string[] = [];

  lines.push('## New Ticket (candidate)');
  lines.push(`Title: ${candidate.title}`);
  lines.push(`Description: ${candidate.description ?? '(none provided)'}`);

  lines.push('');
  lines.push('## Existing Open Tickets');

  if (existing.length === 0) {
    lines.push('(none)');
  } else {
    existing.forEach((t, i) => {
      lines.push(`[${i + 1}] id: ${t.id}`);
      lines.push(`    Title: ${t.title}`);
      lines.push(`    Description: ${t.description ?? '(none provided)'}`);
    });
  }

  lines.push('');
  lines.push(
    'Decide if the new ticket is a duplicate of one of the existing tickets. ' +
    'Output your verdict as a JSON object with {"duplicateOf": "<id>"} or {"duplicateOf": null}.',
  );

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: lines.join('\n') }],
  };
}

// ---------------------------------------------------------------------------
// parseDedupVerdict
// ---------------------------------------------------------------------------

/**
 * Parse the model's text output into a dedup verdict.
 *
 * Extracts the first JSON object found in `text`, validates the shape, and
 * returns `{ duplicateOf: string | null }`.
 *
 * @param text      Raw model output.
 * @param validIds  The set of valid existing-ticket ids. If the model returns an
 *                  id that is not in this set, throw DedupParseError.
 *
 * Throws DedupParseError on any malformed, invalid, or unrecognized id.
 */
export function parseDedupVerdict(
  text: string,
  validIds: string[],
): { duplicateOf: string | null } {
  // Greedy match from first `{` to last `}` (handles prose wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new DedupParseError(
      `No JSON object found in model output. Raw text: ${text.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new DedupParseError(
      `Failed to parse JSON from model output: ${(err as Error).message}. Raw: ${jsonMatch[0].slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DedupParseError('Parsed JSON is not an object.');
  }

  const obj = parsed as Record<string, unknown>;

  if (!('duplicateOf' in obj)) {
    throw new DedupParseError('`duplicateOf` key is missing from model output.');
  }

  const dup = obj['duplicateOf'];

  if (dup === null) {
    return { duplicateOf: null };
  }

  if (typeof dup !== 'string') {
    throw new DedupParseError(
      `\`duplicateOf\` must be a string or null. Got: ${typeof dup}`,
    );
  }

  if (!validIds.includes(dup)) {
    throw new DedupParseError(
      `\`duplicateOf\` value "${dup}" is not one of the valid existing ticket ids.`,
    );
  }

  return { duplicateOf: dup };
}
