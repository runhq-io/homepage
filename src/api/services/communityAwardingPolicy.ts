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
