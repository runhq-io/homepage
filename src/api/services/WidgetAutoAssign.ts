/**
 * WidgetAutoAssign.ts — the single, server-side authority for turning a widget
 * ticket into a running coding-agent job. Runs FIRE-AND-FORGET after every
 * widget ticket is created (chat proposal, agentless submit, direct compose), so
 * it never adds latency to the user's request and is never subject to the
 * gateway origin-timeout window.
 *
 * Two-layer defense:
 *   Layer 1 (identity): only a non-anonymous widget user (a backend-issued token
 *     minted a `widgetUserId`) can produce an auto-assignable ticket.
 *   Layer 2 (content): an injection-guard verdict must pass before any agent is
 *     started. Flagged content downgrades the ticket to feedback-only.
 *
 * The guard gates ASSIGNMENT, not CREATION — the ticket already exists when this
 * runs. That is exactly the "create but don't assign" behaviour for unsafe or
 * unmatchable tickets. Every terminal branch records an outcome so the team can
 * see WHY a ticket was (or wasn't) auto-handled, instead of a silent no-op.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/index';
import { workspaceTasks } from '../../db/schema';
import type { InjectionGuardResult } from './InjectionGuardService';

export type AutoAssignStatus =
  | 'assigned'
  | 'needs_clarification'
  | 'skipped_unsafe'
  | 'skipped_no_agent'
  | 'skipped_duplicate'
  | 'skipped_anon'
  | 'failed';

export interface AutoAssignOutcome {
  status: AutoAssignStatus;
  reasons?: string[];
  agentId?: string;
  jobId?: string;
  duplicateOf?: string;
  /** Set when status === 'needs_clarification' — the open clarification the widget renders. */
  clarificationId?: string;
}

/** Result of the clarifier gate: a clear ticket is `ready`; a thin one `asking`. */
export type ClarifyGateResult = { status: 'ready' } | { status: 'asking'; clarificationId: string };

/**
 * Placeholder agent stored on the auto-flow clarification row. The real agent is
 * picked by the LLM suggester after the ticket is ready, so this is never used
 * to assign — it only satisfies the not-null column.
 */
export const AUTO_ASSIGN_SENTINEL_AGENT = '__auto__';

/** Request shape forwarded to the existing WidgetService.assignAgent. */
export interface AutoAssignRequest {
  agentId: string;
  command: string;
  actor: { widgetUserId: string; externalUserId: string; name: string | null; matchedRoles: string[] };
  qa?: Array<{ question: string; answer: string }>;
}

export interface AutoAssignDeps {
  getProject(projectId: string): Promise<{ serverId: string; agentAssignmentEnabled: boolean } | null>;
  getTicket(serverId: string, ticketId: string): Promise<{ title: string; description: string | null } | null>;
  guard(ticket: { title: string; description: string | null }): Promise<InjectionGuardResult>;
  /**
   * Quality gate: decide whether the ticket has enough detail to act on. A clear
   * ticket resolves `ready` (assign proceeds); a thin/vague one resolves `asking`
   * (questions are persisted + shown in the widget; NO agent is started until the
   * user answers and it becomes ready). Fed the chat-intake Q&A, so a ticket the
   * chat agent already fleshed out resolves `ready` without re-interrogation.
   */
  clarify(
    serverId: string,
    ticketId: string,
    widgetUserId: string,
    ticket: { title: string; description: string | null },
  ): Promise<ClarifyGateResult>;
  findDuplicate(
    serverId: string,
    ticketId: string,
    ticket: { title: string; description: string | null },
  ): Promise<{ duplicateOf: string | null }>;
  /**
   * Ensure the workspace machine is awake before the suggest + assign forwards
   * (both hit the workspace over HTTP). Widget servers auto-suspend on idle, so
   * a fire-and-forget auto-assign frequently fires against a cold machine; an
   * unreachable workspace must NOT be mistaken for "no agent". Returns
   * `reachable:false` when the machine could not be woken — the orchestrator
   * records a transient `failed` and stops before forwarding.
   */
  wakeWorkspace(serverId: string): Promise<{ reachable: boolean }>;
  /**
   * `unavailable:true` means the workspace could not be reached for a verdict
   * (transient) — distinct from a genuine `agentId:null` "no agent" answer.
   */
  suggest(projectId: string, ticketId: string): Promise<{ agentId: string | null; command: string; unavailable?: boolean }>;
  loadIntakeQa(ticketId: string): Promise<Array<{ question: string; answer: string }>>;
  getActor(widgetUserId: string): Promise<{ externalUserId: string; name: string | null } | null>;
  assign(projectId: string, ticketId: string, req: AutoAssignRequest): Promise<{ jobId: string }>;
  /**
   * Flag the ticket's clarification as 'duplicate' (creating one if the gate
   * never wrote a row) so the widget renders the duplicate-notice card with
   * the matched ticket + "Not a duplicate — start anyway" override. Advisory:
   * a failure here must not block recording the skipped_duplicate outcome.
   */
  markDuplicate(serverId: string, ticketId: string, widgetUserId: string, duplicateOfTaskId: string): Promise<void>;
  recordOutcome(serverId: string, ticketId: string, outcome: AutoAssignOutcome): Promise<void>;
}

export type AutoAssignOptions = {
  /**
   * Set by the synchronous widget create path after it has already run the
   * injection guard against this immutable freshly-created ticket. Avoids a
   * duplicate model call before the rest of the assignment gates.
   */
  skipGuard?: boolean;
};

/**
 * Decide whether to auto-assign a coding agent to a freshly-created widget
 * ticket, and do it. NEVER throws (fire-and-forget contract): every failure is
 * logged and, where a server is known, recorded as a `failed` outcome.
 */
export async function maybeAutoAssign(
  projectId: string,
  ticketId: string,
  widgetUserId: string | undefined,
  deps: AutoAssignDeps,
  opts: AutoAssignOptions = {},
): Promise<void> {
  let serverId: string | undefined;
  try {
    const project = await deps.getProject(projectId);
    if (!project) return; // unknown project — nothing to do, nothing to record
    serverId = project.serverId;

    // Feature master switch: a project that hasn't enabled agent assignment
    // never auto-assigns. No outcome — it isn't a candidate.
    if (!project.agentAssignmentEnabled) return;

    // Layer 1 — identity. Anonymous (public-slug / raw-key) reporters can file
    // feedback but can never start an agent.
    if (!widgetUserId) {
      await deps.recordOutcome(serverId, ticketId, { status: 'skipped_anon' });
      return;
    }

    const ticket = await deps.getTicket(serverId, ticketId);
    if (!ticket) return; // race: ticket vanished — leave no outcome

    // Layer 2 — content guard. `unavailable` distinguishes an infra failure
    // (record `failed`) from a genuine content rejection (`skipped_unsafe`).
    if (!opts.skipGuard) {
      const verdict = await deps.guard(ticket);
      if (!verdict.safe) {
        await deps.recordOutcome(serverId, ticketId, {
          status: verdict.unavailable ? 'failed' : 'skipped_unsafe',
          reasons: verdict.reasons,
        });
        return;
      }
    }

    // Quality gate — clarify BEFORE committing an agent. A thin ticket (e.g.
    // "hi") is held for the user to flesh out instead of spawning a job from
    // nothing; a clear ticket (or one the chat agent already fleshed out)
    // passes straight through.
    const clar = await deps.clarify(serverId, ticketId, widgetUserId, ticket);
    if (clar.status === 'asking') {
      await deps.recordOutcome(serverId, ticketId, {
        status: 'needs_clarification',
        clarificationId: clar.clarificationId,
      });
      return;
    }

    await finalizeAutoAssign(projectId, ticketId, widgetUserId, serverId, ticket, deps);
  } catch (err) {
    console.error(`[WidgetAutoAssign] auto-assign failed for ticket ${ticketId}:`, err);
    if (serverId) {
      try {
        await deps.recordOutcome(serverId, ticketId, { status: 'failed' });
      } catch (recErr) {
        console.warn('[WidgetAutoAssign] could not record failed outcome:', recErr);
      }
    }
  }
}

/**
 * The post-clarification tail: dedup → pick agent → assign → record. Shared by
 * `maybeAutoAssign` (when the clarifier is ready up-front) and the
 * clarify-answer route (when the user's answers make it ready). Throws on
 * failure — callers wrap it (maybeAutoAssign's try/catch; the route's handler).
 */
export async function finalizeAutoAssign(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
  serverId: string,
  ticket: { title: string; description: string | null },
  deps: AutoAssignDeps,
  opts?: {
    /**
     * Skip the dedup check. Set by the clarify-proceed route after the
     * reporter overrides a duplicate verdict ("Not a duplicate — start
     * anyway") — re-running dedup would just re-flag the same ticket.
     */
    skipDedup?: boolean;
  },
): Promise<AutoAssignOutcome> {
  // Dedup: a likely duplicate is created but not assigned (avoids N duplicate
  // agent runs from N similar reports).
  if (!opts?.skipDedup) {
    const dup = await deps.findDuplicate(serverId, ticketId, ticket);
    if (dup.duplicateOf) {
      // Make the verdict visible to the reporter — the widget renders the
      // duplicate card off the clarification row. Advisory: the outcome is
      // recorded either way.
      try {
        await deps.markDuplicate(serverId, ticketId, widgetUserId, dup.duplicateOf);
      } catch (err) {
        console.warn('[WidgetAutoAssign] could not mark clarification duplicate:', err);
      }
      const outcome: AutoAssignOutcome = { status: 'skipped_duplicate', duplicateOf: dup.duplicateOf };
      await deps.recordOutcome(serverId, ticketId, outcome);
      return outcome;
    }
  }

  // Wake the workspace before the suggest + assign forwards — both reach the
  // workspace over HTTP, and a suspended/cold machine would fail the one-shot
  // call and be mis-recorded as `skipped_no_agent`. We can afford the wait:
  // this whole path is fire-and-forget, off the user's request.
  const awake = await deps.wakeWorkspace(serverId);
  if (!awake.reachable) {
    const outcome: AutoAssignOutcome = { status: 'failed', reasons: ['workspace_unreachable'] };
    await deps.recordOutcome(serverId, ticketId, outcome);
    return outcome;
  }

  // Agent selection — the existing LLM picker over the project's exposed agents.
  const suggestion = await deps.suggest(projectId, ticketId);
  if (suggestion.unavailable) {
    // Could not reach the workspace for a verdict — transient, not "no agent".
    const outcome: AutoAssignOutcome = { status: 'failed', reasons: ['suggest_unreachable'] };
    await deps.recordOutcome(serverId, ticketId, outcome);
    return outcome;
  }
  if (!suggestion.agentId) {
    const outcome: AutoAssignOutcome = { status: 'skipped_no_agent' };
    await deps.recordOutcome(serverId, ticketId, outcome);
    return outcome;
  }

  const [actor, qa] = await Promise.all([
    deps.getActor(widgetUserId),
    deps.loadIntakeQa(ticketId),
  ]);
  if (!actor) {
    const outcome: AutoAssignOutcome = { status: 'failed' };
    await deps.recordOutcome(serverId, ticketId, outcome);
    return outcome;
  }

  const { jobId } = await deps.assign(projectId, ticketId, {
    agentId: suggestion.agentId,
    command: suggestion.command,
    actor: {
      widgetUserId,
      externalUserId: actor.externalUserId,
      name: actor.name,
      matchedRoles: [], // role-gating removed — identity alone authorizes
    },
    ...(qa.length > 0 ? { qa } : {}),
  });

  const outcome: AutoAssignOutcome = { status: 'assigned', agentId: suggestion.agentId, jobId };
  await deps.recordOutcome(serverId, ticketId, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Default production wiring
// ---------------------------------------------------------------------------

/**
 * Persist the auto-assign outcome on the ticket's existing `metadata` jsonb
 * under the `autoAssign` key (idiomatic use of the column documented as "action
 * details, screenshots refs, etc."). Merge-preserves any user-supplied context.
 */
async function recordOutcome(
  serverId: string,
  ticketId: string,
  outcome: AutoAssignOutcome,
): Promise<void> {
  const payload = JSON.stringify({ ...outcome, at: new Date().toISOString() });
  await db
    .update(workspaceTasks)
    .set({
      metadata: sql`COALESCE(${workspaceTasks.metadata}, '{}'::jsonb) || jsonb_build_object('autoAssign', ${payload}::jsonb)`,
    })
    .where(sql`${workspaceTasks.id} = ${ticketId} AND ${workspaceTasks.serverId} = ${serverId}`);
}

/**
 * Real dependency wiring. Lazy-imports the heavy service modules so unit tests
 * of `maybeAutoAssign` (which inject their own deps) never pull in the DB/SDK.
 */
export async function defaultAutoAssignDeps(): Promise<AutoAssignDeps> {
  const WidgetService = await import('./WidgetService');
  const DedupService = await import('./DedupService');
  const InjectionGuardService = await import('./InjectionGuardService');
  const ClarifierService = await import('./ClarifierService');

  return {
    getProject: (projectId) => WidgetService.getAutoAssignProject(projectId),
    getTicket: (serverId, ticketId) => WidgetService.getWidgetTaskForServer(serverId, ticketId),
    guard: (ticket) => InjectionGuardService.checkTicket(ticket),
    clarify: async (serverId, ticketId, widgetUserId, ticket) => {
      // The agent is chosen AFTER clarification (by the picker), so the
      // clarification row stores a sentinel agent — vestigial for this path.
      // Quality gate fails OPEN: a clarifier outage must not block legit
      // tickets, so any error resolves to `ready` (assign proceeds).
      try {
        const step = await ClarifierService.startClarification({
          serverId,
          taskId: ticketId,
          widgetUserId,
          ticket,
          agentId: AUTO_ASSIGN_SENTINEL_AGENT,
          command: '',
        });
        return step.status === 'asking'
          ? { status: 'asking', clarificationId: step.clarificationId }
          : { status: 'ready' };
      } catch (err) {
        console.warn('[WidgetAutoAssign] clarifier unavailable; proceeding without clarification:', err);
        return { status: 'ready' };
      }
    },
    wakeWorkspace: (serverId) => WidgetService.ensureWorkspaceAwake(serverId),
    findDuplicate: (serverId, ticketId, ticket) =>
      // Dev escape hatch: WIDGET_AUTOASSIGN_DISABLE_DEDUP=true skips dedup so the
      // same test ticket can be filed repeatedly without being blocked. NEVER
      // set in production — dedup is what prevents N agents on N copies.
      process.env.WIDGET_AUTOASSIGN_DISABLE_DEDUP === 'true'
        ? Promise.resolve({ duplicateOf: null })
        : DedupService.findLikelyDuplicate({ serverId, ticketId, candidate: ticket }),
    suggest: (projectId, ticketId) => WidgetService.suggestAssignment(projectId, ticketId),
    loadIntakeQa: (ticketId) => ClarifierService.defaultLoadIntakeQa(ticketId),
    getActor: (widgetUserId) => WidgetService.getWidgetUserAuditInfo(widgetUserId),
    assign: (projectId, ticketId, req) => WidgetService.assignAgent(projectId, ticketId, req),
    markDuplicate: (serverId, ticketId, widgetUserId, duplicateOfTaskId) =>
      ClarifierService.markTicketDuplicate({
        serverId,
        taskId: ticketId,
        widgetUserId,
        duplicateOfTaskId,
        agentId: AUTO_ASSIGN_SENTINEL_AGENT,
      }).then(() => undefined),
    recordOutcome,
  };
}

/**
 * Convenience entry used by the create paths: resolve real deps then run.
 * Swallows everything — callers invoke as `void autoAssignTicket(...)`.
 */
export async function autoAssignTicket(
  projectId: string,
  ticketId: string,
  widgetUserId: string | undefined,
  opts: AutoAssignOptions = {},
): Promise<void> {
  try {
    const deps = await defaultAutoAssignDeps();
    await maybeAutoAssign(projectId, ticketId, widgetUserId, deps, opts);
  } catch (err) {
    console.error('[WidgetAutoAssign] autoAssignTicket failed to run:', err);
  }
}

/**
 * Run the assign tail (dedup → pick agent → assign) for a ticket whose
 * clarification just became ready. Used by the clarify-answer route after the
 * user's answers resolve the clarifier. Resolves real deps; returns the outcome
 * so the route can report it. Throws on hard failure (the route maps it).
 */
export async function finalizeAutoAssignTicket(
  projectId: string,
  ticketId: string,
  widgetUserId: string,
  opts?: { skipDedup?: boolean },
): Promise<AutoAssignOutcome> {
  const deps = await defaultAutoAssignDeps();
  const project = await deps.getProject(projectId);
  if (!project) return { status: 'failed' };
  const ticket = await deps.getTicket(project.serverId, ticketId);
  if (!ticket) return { status: 'failed' };
  return finalizeAutoAssign(projectId, ticketId, widgetUserId, project.serverId, ticket, deps, opts);
}
