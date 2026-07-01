import { describe, it, expect } from 'vitest';
import {
  isPayoutEligible,
  computePayoutAmount,
  TERMINAL_SUCCESS_STATUSES,
  autoCompletionIdempotencyKey,
  adminGrantIdempotencyKey,
  reversalIdempotencyKey,
  backfillIdempotencyKey,
  type StatusChangeEvent,
} from './communityAwardingPolicy';

const baseEvent: StatusChangeEvent = {
  ticketId: 't1',
  projectId: 'p1',
  sourceType: 'widget',
  externalUserId: 'sub-1',
  oldStatus: 'in_progress',
  newStatus: 'done',
  upvoteCountAtTransition: 0,
  selfUpvoted: false,
  occurredAt: '2026-04-26T00:00:00Z',
};

describe('isPayoutEligible', () => {
  it('returns true on first reach of done from non-terminal', () => {
    expect(isPayoutEligible(baseEvent)).toBe(true);
  });

  it('returns true on first reach of deployed from non-terminal', () => {
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'deployed' })).toBe(true);
  });

  it('returns false when newStatus is not terminal-success', () => {
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'cancelled' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'in_progress' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'pending' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'planned' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, newStatus: 'needs_review' })).toBe(false);
  });

  it('returns false when oldStatus is already terminal-success (re-completion)', () => {
    expect(isPayoutEligible({ ...baseEvent, oldStatus: 'done', newStatus: 'deployed' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, oldStatus: 'deployed', newStatus: 'done' })).toBe(false);
    expect(isPayoutEligible({ ...baseEvent, oldStatus: 'done', newStatus: 'done' })).toBe(false);
  });

  it('returns false when sourceType is native', () => {
    expect(isPayoutEligible({ ...baseEvent, sourceType: 'native' })).toBe(false);
  });

  it('returns false when externalUserId is null', () => {
    expect(isPayoutEligible({ ...baseEvent, externalUserId: null })).toBe(false);
  });

  it('returns false when externalUserId is empty string', () => {
    expect(isPayoutEligible({ ...baseEvent, externalUserId: '' })).toBe(false);
  });
});

describe('computePayoutAmount', () => {
  it('returns 10 with zero upvotes', () => {
    expect(computePayoutAmount({ ...baseEvent, upvoteCountAtTransition: 0 })).toBe(10);
  });

  it('adds non-self upvote count to base', () => {
    expect(computePayoutAmount({
      ...baseEvent, upvoteCountAtTransition: 100, selfUpvoted: false,
    })).toBe(110);
  });

  it('subtracts the self-upvote from the count', () => {
    expect(computePayoutAmount({
      ...baseEvent, upvoteCountAtTransition: 100, selfUpvoted: true,
    })).toBe(109);
  });

  it('floors non-self at 0 if all upvotes were self (defensive)', () => {
    expect(computePayoutAmount({
      ...baseEvent, upvoteCountAtTransition: 1, selfUpvoted: true,
    })).toBe(10);
  });
});

describe('TERMINAL_SUCCESS_STATUSES', () => {
  it('contains exactly done and deployed', () => {
    expect(TERMINAL_SUCCESS_STATUSES).toEqual(new Set(['done', 'deployed']));
  });
});

describe('idempotency key builders', () => {
  it('autoCompletion uses ticketId', () => {
    expect(autoCompletionIdempotencyKey('t-abc')).toBe('auto_completion:t-abc');
  });
  it('adminGrant uses clientRequestId', () => {
    expect(adminGrantIdempotencyKey('req-xyz')).toBe('admin_grant:req-xyz');
  });
  it('reversal uses original grantId', () => {
    expect(reversalIdempotencyKey('g-1')).toBe('reversal:g-1');
  });
  it('backfill uses ticketId', () => {
    expect(backfillIdempotencyKey('t-abc')).toBe('backfill:t-abc');
  });
});

// ---------------------------------------------------------------------------
// Step-coins policy
// ---------------------------------------------------------------------------
import {
  tierOrdinal,
  crossedTiers,
  STEP_COIN,
  stepAdvanceIdempotencyKey,
  tierLabel,
  stepReason,
} from './communityAwardingPolicy';

describe('tierOrdinal', () => {
  it('maps the ladder', () => {
    expect(tierOrdinal('planned')).toBe(0);
    expect(tierOrdinal('in_progress')).toBe(1);
    expect(tierOrdinal('reviewed')).toBe(2);
    expect(tierOrdinal('merged')).toBe(3);
    expect(tierOrdinal('deployed')).toBe(4);
  });
  it('treats done as the reviewed tier', () => {
    expect(tierOrdinal('done')).toBe(2);
  });
  it('normalizes deployed:<env> to the deployed tier', () => {
    expect(tierOrdinal('deployed:prod')).toBe(4);
    expect(tierOrdinal('deployed:staging-123')).toBe(4);
  });
  it('puts off-ladder statuses at -1', () => {
    expect(tierOrdinal('pending')).toBe(-1);
    expect(tierOrdinal('needs_review')).toBe(-1);
    expect(tierOrdinal('cancelled')).toBe(-1);
    expect(tierOrdinal('nonsense')).toBe(-1);
  });
});

describe('crossedTiers', () => {
  it('single forward step', () => {
    expect(crossedTiers('planned', 'in_progress')).toEqual(['in_progress']);
  });
  it('multi-step forward jump crosses every tier once, in order', () => {
    expect(crossedTiers('planned', 'merged')).toEqual(['in_progress', 'reviewed', 'merged']);
  });
  it('full run', () => {
    expect(crossedTiers('planned', 'deployed')).toEqual(['in_progress', 'reviewed', 'merged', 'deployed']);
  });
  it('backward transition rewards nothing', () => {
    expect(crossedTiers('merged', 'in_progress')).toEqual([]);
  });
  it('same-tier transition rewards nothing', () => {
    expect(crossedTiers('reviewed', 'reviewed')).toEqual([]);
    expect(crossedTiers('done', 'reviewed')).toEqual([]); // done == reviewed ordinal
  });
  it('coming from an off-ladder status counts from the planned baseline', () => {
    expect(crossedTiers('pending', 'reviewed')).toEqual(['in_progress', 'reviewed']);
  });
  it('into an off-ladder status rewards nothing', () => {
    expect(crossedTiers('merged', 'cancelled')).toEqual([]);
  });
  it('into planned rewards nothing', () => {
    expect(crossedTiers('pending', 'planned')).toEqual([]);
  });
});

describe('step keys, labels, reasons', () => {
  it('STEP_COIN is 1', () => {
    expect(STEP_COIN).toBe(1);
  });
  it('idempotency key format is stable', () => {
    expect(stepAdvanceIdempotencyKey('t1', 'merged', 'u1')).toBe('step:t1:merged:u1');
  });
  it('tier labels are human', () => {
    expect(tierLabel('in_progress')).toBe('In progress');
    expect(tierLabel('deployed')).toBe('Deployed');
  });
  it('reasons read naturally', () => {
    expect(stepReason('creator', 'reviewed')).toBe('You submitted this and it reached Reviewed');
    expect(stepReason('voter', 'merged')).toBe('You upvoted this and it reached Merged');
  });
});
