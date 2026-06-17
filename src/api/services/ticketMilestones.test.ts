/**
 * ticketMilestones.test.ts — pure-function unit tests for the partner-facing
 * milestone derivation. No DB, no network.
 *
 * The milestone model is the ONLY representation of agent/ticket progress shown
 * to external widget users. It must be total (handle every status) and must
 * never depend on data a partner shouldn't see (it takes only a status enum,
 * clarification status, agent-assigned flag, and PR state — never code).
 */
import { describe, it, expect } from 'vitest';
import { deriveTicketMilestones, type MilestoneInput } from './ticketMilestones';

function keysWithState(input: MilestoneInput) {
  return deriveTicketMilestones(input).map((m) => `${m.key}:${m.state}`);
}

describe('deriveTicketMilestones', () => {
  it('fresh pending ticket: received is current, rest upcoming, no clarifying step', () => {
    expect(keysWithState({ status: 'pending' })).toEqual([
      'received:current',
      'in_progress:upcoming',
      'in_review:upcoming',
      'shipped:upcoming',
    ]);
  });

  it('inserts the clarifying step only when a clarification exists', () => {
    expect(keysWithState({ status: 'pending', clarificationStatus: 'asking' })).toEqual([
      'received:done',
      'clarifying:current',
      'in_progress:upcoming',
      'in_review:upcoming',
      'shipped:upcoming',
    ]);
  });

  it('clarification resolved (ready) advances to in_progress', () => {
    expect(keysWithState({ status: 'pending', clarificationStatus: 'ready' })).toEqual([
      'received:done',
      'clarifying:done',
      'in_progress:current',
      'in_review:upcoming',
      'shipped:upcoming',
    ]);
  });

  it('agent assigned (still pending) advances to in_progress', () => {
    expect(keysWithState({ status: 'pending', agentAssigned: true })).toEqual([
      'received:done',
      'in_progress:current',
      'in_review:upcoming',
      'shipped:upcoming',
    ]);
  });

  it('in_progress status', () => {
    expect(keysWithState({ status: 'in_progress' })).toEqual([
      'received:done',
      'in_progress:current',
      'in_review:upcoming',
      'shipped:upcoming',
    ]);
  });

  it('needs_review status advances to in_review', () => {
    expect(keysWithState({ status: 'needs_review' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:current',
      'shipped:upcoming',
    ]);
  });

  it('an open PR advances to in_review even while status is in_progress', () => {
    expect(keysWithState({ status: 'in_progress', prState: 'open' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:current',
      'shipped:upcoming',
    ]);
  });

  it('done (finished, not shipped): in_review current, shipped upcoming', () => {
    expect(keysWithState({ status: 'done' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:current',
      'shipped:upcoming',
    ]);
  });

  it('deployed: every step done including shipped (terminal complete)', () => {
    expect(keysWithState({ status: 'deployed' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'shipped:done',
    ]);
  });

  it('cancelled collapses to received + a closed terminal step', () => {
    expect(keysWithState({ status: 'cancelled' })).toEqual([
      'received:done',
      'closed:current',
    ]);
  });

  it('every milestone carries a non-empty human label', () => {
    for (const m of deriveTicketMilestones({ status: 'in_progress', clarificationStatus: 'asking', prState: 'open' })) {
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('is total: never throws for any status value', () => {
    const statuses: MilestoneInput['status'][] = [
      'pending', 'planned', 'in_progress', 'needs_review', 'done', 'deployed', 'cancelled',
    ];
    for (const status of statuses) {
      expect(() => deriveTicketMilestones({ status })).not.toThrow();
      expect(deriveTicketMilestones({ status }).length).toBeGreaterThan(0);
    }
  });
});
