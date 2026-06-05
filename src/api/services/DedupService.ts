/**
 * DedupService.ts — DB glue + LLM orchestration for duplicate ticket detection.
 *
 * Checks whether a new widget ticket is likely a duplicate of a recent open ticket
 * on the same server. Advisory only — callers MUST treat errors as fail-open
 * (no duplicate found) to avoid blocking legitimate tickets.
 *
 * Mirrors the ClarifierService pattern: pure core (dedupCore) + injectable
 * CallModel for testing + real Haiku default in production.
 */

import { db } from '../../db/index';
import { workspaceTasks } from '../../db/schema';
import { eq, and, ne, isNull, notInArray } from 'drizzle-orm';
import type { CallModel } from './ClarifierService';
import { buildDedupMessages, parseDedupVerdict, DedupParseError } from './dedupCore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of open tickets to compare against. */
const MAX_CANDIDATES = 50;

/**
 * Task statuses that are considered "open" / not yet resolved.
 * Statuses 'done', 'deployed', and 'cancelled' are excluded.
 */
const OPEN_STATUSES: Array<'pending' | 'planned' | 'in_progress' | 'needs_review'> = [
  'pending',
  'planned',
  'in_progress',
  'needs_review',
];

// ---------------------------------------------------------------------------
// Default real model call (Haiku) — lazy import mirrors ClarifierService
// ---------------------------------------------------------------------------

async function defaultCallModel(args: {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<string> {
  const { getSettings } = await import('./SettingsService');
  const settings = await getSettings();
  const apiKey = settings.claudeApiKey;
  if (!apiKey) throw new Error('No claudeApiKey configured');

  const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey });
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: args.system,
    messages: args.messages,
  });
  const t = resp.content.find((b) => b.type === 'text');
  if (!t || t.type !== 'text') throw new Error('No text block in model response');
  return t.text;
}

// ---------------------------------------------------------------------------
// findLikelyDuplicate
// ---------------------------------------------------------------------------

export interface FindLikelyDuplicateArgs {
  /** The server that owns the candidate ticket. Used to scope the candidate set. */
  serverId: string;
  /**
   * Optional workspace project id. When provided, the candidate set is further
   * scoped to the same project. When null/undefined, all open tickets on the
   * server are compared (cross-project dedup).
   */
  projectId?: string | null;
  /** The id of the ticket being checked — excluded from the candidate set. */
  ticketId: string;
  /** The candidate ticket's title and description. */
  candidate: { title: string; description?: string | null };
}

/**
 * Determine whether the candidate ticket is likely a duplicate of a recently
 * opened ticket on the same server.
 *
 * Returns `{ duplicateOf: <taskId> }` when a clear duplicate is found, or
 * `{ duplicateOf: null }` otherwise.
 *
 * ALWAYS fails open: any DB or model error returns `{ duplicateOf: null }` so
 * that a checker failure can never silently block a real ticket.
 */
export async function findLikelyDuplicate(
  args: FindLikelyDuplicateArgs,
  deps?: { callModel?: CallModel },
): Promise<{ duplicateOf: string | null }> {
  const FAIL_OPEN = { duplicateOf: null };

  try {
    // 1. Query recent open tickets for the same server, excluding the current ticket.
    const conditions = [
      eq(workspaceTasks.serverId, args.serverId),
      isNull(workspaceTasks.deletedAt),
      ne(workspaceTasks.id, args.ticketId),
      // status IN (...open statuses) — drizzle doesn't have inArray for enum unions,
      // but notInArray with the closed statuses is equivalent and simpler:
      notInArray(workspaceTasks.status, ['done', 'deployed', 'cancelled'] as any[]),
    ];

    if (args.projectId) {
      conditions.push(eq(workspaceTasks.workspaceProjectId, args.projectId));
    }

    const existing = await db
      .select({
        id: workspaceTasks.id,
        title: workspaceTasks.title,
        description: workspaceTasks.description,
      })
      .from(workspaceTasks)
      .where(and(...conditions))
      .orderBy(workspaceTasks.createdAt)
      .limit(MAX_CANDIDATES);

    // 2. No candidates → no duplicate possible, skip model call.
    if (existing.length === 0) {
      return FAIL_OPEN;
    }

    // 3. Build prompt + call model.
    const callModel = deps?.callModel ?? defaultCallModel;
    const { system, messages } = buildDedupMessages(args.candidate, existing);
    const text = await callModel({ system, messages });

    // 4. Parse verdict — fail-open on parse error.
    const validIds = existing.map((t) => t.id);
    const verdict = parseDedupVerdict(text, validIds);

    return verdict;
  } catch (err) {
    // Any error (DB, network, parse) → fail-open. This ensures the dedup check
    // can never prevent a legitimate ticket from being processed.
    if (!(err instanceof DedupParseError)) {
      console.error('[DedupService] findLikelyDuplicate error (fail-open):', err);
    }
    return FAIL_OPEN;
  }
}
