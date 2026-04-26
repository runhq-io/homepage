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
