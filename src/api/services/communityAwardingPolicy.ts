export type TodoStatus =
  | 'pending'
  | 'planned'
  | 'in_progress'
  | 'needs_review'
  | 'done'
  | 'deployed'
  | 'cancelled';

export const TERMINAL_SUCCESS_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>([
  'done',
  'deployed',
]);

export interface StatusChangeEvent {
  ticketId: string;
  projectId: string;
  sourceType: 'native' | 'widget';
  externalUserId: string | null;
  oldStatus: TodoStatus;
  newStatus: TodoStatus;
  upvoteCountAtTransition: number;
  selfUpvoted: boolean;
  occurredAt: string;
}

/**
 * Returns true if this status-change event should trigger an automatic point award.
 *
 * Eligibility rules (ALL must hold):
 *  1. sourceType is 'widget' — native RunHQ users don't receive community points
 *  2. externalUserId is present — we must know who to credit
 *  3. newStatus is a terminal-success status (done | deployed)
 *  4. oldStatus is NOT already a terminal-success status — prevents double-awarding
 *     on re-completion transitions (e.g. done → deployed)
 */
export function isPayoutEligible(event: StatusChangeEvent): boolean {
  if (event.sourceType !== 'widget') return false;
  if (!event.externalUserId) return false;
  if (TERMINAL_SUCCESS_STATUSES.has(event.oldStatus)) return false;
  if (!TERMINAL_SUCCESS_STATUSES.has(event.newStatus)) return false;
  return true;
}

const BASE_PAYOUT = 10;

/**
 * Computes the point amount to award for a completed ticket.
 *
 * Formula: BASE_PAYOUT (10) + non-self upvotes
 *
 * The upvoteCountAtTransition includes the author's own upvote if selfUpvoted is true,
 * so we subtract 1 in that case. We floor at 0 defensively — if the stored count
 * somehow doesn't reflect the self-vote we do not produce a negative bonus.
 */
export function computePayoutAmount(event: StatusChangeEvent): number {
  const nonSelfUpvotes = Math.max(
    0,
    event.upvoteCountAtTransition - (event.selfUpvoted ? 1 : 0),
  );
  return BASE_PAYOUT + nonSelfUpvotes;
}

// ---------------------------------------------------------------------------
// Idempotency key builders
//
// Keys are persisted in point_grants.idempotency_key (UNIQUE constraint).
// The format <source>:<id> must never change once data is in production.
// ---------------------------------------------------------------------------

export function autoCompletionIdempotencyKey(ticketId: string): string {
  return `auto_completion:${ticketId}`;
}

export function adminGrantIdempotencyKey(clientRequestId: string): string {
  return `admin_grant:${clientRequestId}`;
}

export function reversalIdempotencyKey(originalGrantId: string): string {
  return `reversal:${originalGrantId}`;
}

export function backfillIdempotencyKey(ticketId: string): string {
  return `backfill:${ticketId}`;
}

// ---------------------------------------------------------------------------
// Step-coins policy
//
// Ticket creators and external up-voters earn STEP_COIN each time a widget
// ticket advances a rewardable lifecycle tier. This section owns the ladder,
// the "which tiers did this transition cross" logic, and the stable
// idempotency-key + reason strings. Pure functions, no I/O.
//
// This supersedes the completion-only payout above as the awarding path fired
// from WorkspaceTaskService; the completion helpers are retained (dormant) so
// the ledger's existing tests and admin/reversal flows are untouched.
// ---------------------------------------------------------------------------

/** Rewardable tiers, in ascending order. `planned` is the baseline (ordinal 0, not itself rewarded). */
export type StepTier = 'in_progress' | 'reviewed' | 'merged' | 'deployed';

const STEP_LADDER: readonly StepTier[] = ['in_progress', 'reviewed', 'merged', 'deployed'];

/** Fixed coin granted per crossed tier, per recipient. */
export const STEP_COIN = 1;

/**
 * Ordinal of a status on the lifecycle ladder.
 *   planned=0, in_progress=1, reviewed=2, merged=3, deployed=4.
 * `done` is a legacy synonym for the reviewed tier (2).
 * `deployed:<env>` normalizes to deployed (4).
 * Everything off-ladder (pending, needs_review, cancelled, unknown) is -1.
 */
export function tierOrdinal(status: string): number {
  if (status === 'deployed' || status.startsWith('deployed:')) return 4;
  switch (status) {
    case 'planned': return 0;
    case 'in_progress': return 1;
    case 'reviewed': return 2;
    case 'done': return 2;
    case 'merged': return 3;
    default: return -1;
  }
}

/**
 * The rewardable tiers a transition crosses, forward-only, in ascending order.
 * Returns tiers whose ordinal is in (oldOrdinal, newOrdinal].
 * An off-ladder old status is treated as the `planned` baseline (0) so a jump
 * from e.g. pending → reviewed still rewards in_progress + reviewed. Backward or
 * same-tier transitions, and transitions into off-ladder / `planned`, reward nothing.
 */
export function crossedTiers(oldStatus: string, newStatus: string): StepTier[] {
  const newOrd = tierOrdinal(newStatus);
  if (newOrd < 1) return []; // into off-ladder or into `planned` — nothing rewardable
  const rawOld = tierOrdinal(oldStatus);
  const oldOrd = rawOld < 0 ? 0 : rawOld; // off-ladder start counts from planned baseline
  if (newOrd <= oldOrd) return [];
  // STEP_LADDER[i] has ordinal i+1; include tiers with ordinal in (oldOrd, newOrd].
  return STEP_LADDER.filter((_, i) => {
    const ord = i + 1;
    return ord > oldOrd && ord <= newOrd;
  });
}

/**
 * Idempotency key for one (ticket, tier, recipient) award. Persisted in
 * point_grants.idempotency_key (UNIQUE). Format is permanent once in prod.
 */
export function stepAdvanceIdempotencyKey(ticketId: string, tier: StepTier, widgetUserId: string): string {
  return `step:${ticketId}:${tier}:${widgetUserId}`;
}

/** Human, sentence-case label for a tier. */
export function tierLabel(tier: StepTier): string {
  switch (tier) {
    case 'in_progress': return 'In progress';
    case 'reviewed': return 'Reviewed';
    case 'merged': return 'Merged';
    case 'deployed': return 'Deployed';
  }
}

/** User-facing reason stored on the grant and shown in the hover tooltip. */
export function stepReason(role: 'creator' | 'voter', tier: StepTier): string {
  const verb = role === 'creator' ? 'submitted' : 'upvoted';
  return `You ${verb} this and it reached ${tierLabel(tier)}`;
}
