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
}

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
  findDuplicate(
    serverId: string,
    ticketId: string,
    ticket: { title: string; description: string | null },
  ): Promise<{ duplicateOf: string | null }>;
  suggest(projectId: string, ticketId: string): Promise<{ agentId: string | null; command: string }>;
  loadIntakeQa(ticketId: string): Promise<Array<{ question: string; answer: string }>>;
  getActor(widgetUserId: string): Promise<{ externalUserId: string; name: string | null } | null>;
  assign(projectId: string, ticketId: string, req: AutoAssignRequest): Promise<{ jobId: string }>;
  recordOutcome(serverId: string, ticketId: string, outcome: AutoAssignOutcome): Promise<void>;
}

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
    const verdict = await deps.guard(ticket);
    if (!verdict.safe) {
      await deps.recordOutcome(serverId, ticketId, {
        status: verdict.unavailable ? 'failed' : 'skipped_unsafe',
        reasons: verdict.reasons,
      });
      return;
    }

    // Dedup: a likely duplicate is created but not assigned (avoids N duplicate
    // agent runs from N similar reports).
    const dup = await deps.findDuplicate(serverId, ticketId, ticket);
    if (dup.duplicateOf) {
      await deps.recordOutcome(serverId, ticketId, {
        status: 'skipped_duplicate',
        duplicateOf: dup.duplicateOf,
      });
      return;
    }

    // Agent selection — the existing LLM picker over the project's exposed agents.
    const suggestion = await deps.suggest(projectId, ticketId);
    if (!suggestion.agentId) {
      await deps.recordOutcome(serverId, ticketId, { status: 'skipped_no_agent' });
      return;
    }

    const [actor, qa] = await Promise.all([
      deps.getActor(widgetUserId),
      deps.loadIntakeQa(ticketId),
    ]);
    if (!actor) {
      await deps.recordOutcome(serverId, ticketId, { status: 'failed' });
      return;
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

    await deps.recordOutcome(serverId, ticketId, {
      status: 'assigned',
      agentId: suggestion.agentId,
      jobId,
    });
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
    findDuplicate: (serverId, ticketId, ticket) =>
      DedupService.findLikelyDuplicate({ serverId, ticketId, candidate: ticket }),
    suggest: (projectId, ticketId) => WidgetService.suggestAssignment(projectId, ticketId),
    loadIntakeQa: (ticketId) => ClarifierService.defaultLoadIntakeQa(ticketId),
    getActor: (widgetUserId) => WidgetService.getWidgetUserAuditInfo(widgetUserId),
    assign: (projectId, ticketId, req) => WidgetService.assignAgent(projectId, ticketId, req),
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
): Promise<void> {
  try {
    const deps = await defaultAutoAssignDeps();
    await maybeAutoAssign(projectId, ticketId, widgetUserId, deps);
  } catch (err) {
    console.error('[WidgetAutoAssign] autoAssignTicket failed to run:', err);
  }
}
