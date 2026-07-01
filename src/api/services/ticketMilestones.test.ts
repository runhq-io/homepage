/**
 * ticketMilestones.test.ts — pure-function unit tests for the partner-facing
 * milestone derivation. No DB, no network.
 *
 * The milestone model is the ONLY representation of agent/ticket progress shown
 * to external widget users. It must be total (handle every status) and must
 * never depend on data a partner shouldn't see (it takes a status enum,
 * clarification status, agent-assigned flag, PR state, and a deploy-env id→name
 * map used only to label the deploy step — never code).
 *
 * The track mirrors the runhq lifecycle: done → "In review", reviewed →
 * "Reviewed", merged → "Merged", deployed → "Deployed" (each its own step),
 * with pending/planned sharing "Received".
 */
import { describe, it, expect } from 'vitest';
import { deriveTicketMilestones, type MilestoneInput } from './ticketMilestones';

function keysWithState(input: MilestoneInput) {
  return deriveTicketMilestones(input).map((m) => `${m.key}:${m.state}`);
}

function labelFor(input: MilestoneInput, key: string) {
  return deriveTicketMilestones(input).find((m) => m.key === key)?.label;
}

describe('deriveTicketMilestones', () => {
  it('fresh pending ticket: received is current, rest upcoming, no clarifying step', () => {
    expect(keysWithState({ status: 'pending' })).toEqual([
      'received:current',
      'in_progress:upcoming',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('planned behaves like pending (both map to received)', () => {
    expect(keysWithState({ status: 'planned' })).toEqual([
      'received:current',
      'in_progress:upcoming',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('inserts the clarifying step only when a clarification exists', () => {
    expect(keysWithState({ status: 'pending', clarificationStatus: 'asking' })).toEqual([
      'received:done',
      'clarifying:current',
      'in_progress:upcoming',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('clarification resolved (ready) advances to in_progress', () => {
    expect(keysWithState({ status: 'pending', clarificationStatus: 'ready' })).toEqual([
      'received:done',
      'clarifying:done',
      'in_progress:current',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('agent assigned (still pending) advances to in_progress', () => {
    expect(keysWithState({ status: 'pending', agentAssigned: true })).toEqual([
      'received:done',
      'in_progress:current',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('in_progress status', () => {
    expect(keysWithState({ status: 'in_progress' })).toEqual([
      'received:done',
      'in_progress:current',
      'in_review:upcoming',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('done (PR up, under review): in_review current', () => {
    expect(keysWithState({ status: 'done' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:current',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('an open PR advances to in_review even while status is in_progress', () => {
    expect(keysWithState({ status: 'in_progress', prState: 'open' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:current',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('reviewed status: its own step (approved, awaiting merge)', () => {
    expect(keysWithState({ status: 'reviewed' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'reviewed:current',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('merged status: its own step (landed in base, pre-ship)', () => {
    expect(keysWithState({ status: 'merged' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'reviewed:done',
      'merged:current',
      'deployed:upcoming',
    ]);
  });

  it('a merged PR advances to the merged step even while status lags', () => {
    expect(keysWithState({ status: 'in_progress', prState: 'merged' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'reviewed:done',
      'merged:current',
      'deployed:upcoming',
    ]);
  });

  it('deployed (legacy bare): every step done including deployed (terminal complete)', () => {
    expect(keysWithState({ status: 'deployed' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'reviewed:done',
      'merged:done',
      'deployed:done',
    ]);
  });

  it('deployed:<env> (env-qualified): every step done including deployed (terminal complete)', () => {
    expect(keysWithState({ status: 'deployed:11111111-2222-3333-4444-555555555555' })).toEqual([
      'received:done',
      'in_progress:done',
      'in_review:done',
      'reviewed:done',
      'merged:done',
      'deployed:done',
    ]);
  });

  it('resolves deployed:<env> to "Deployed → <name>" when the env map is provided', () => {
    const environments = [
      { id: 'env-stg', name: 'staging' },
      { id: 'env-prod', name: 'production' },
    ];
    expect(labelFor({ status: 'deployed:env-prod', environments }, 'deployed')).toBe('Deployed → production');
    expect(labelFor({ status: 'deployed:env-stg', environments }, 'deployed')).toBe('Deployed → staging');
  });

  it('falls back to the bare "Deployed" label (never the raw id) for unknown/legacy/upcoming deploys', () => {
    const environments = [{ id: 'env-prod', name: 'production' }];
    // Unknown env id in the map
    expect(labelFor({ status: 'deployed:ghost', environments }, 'deployed')).toBe('Deployed');
    // Legacy bare `deployed`
    expect(labelFor({ status: 'deployed', environments }, 'deployed')).toBe('Deployed');
    // No env map at all
    expect(labelFor({ status: 'deployed:env-prod' }, 'deployed')).toBe('Deployed');
    // Upcoming deploy step (ticket not deployed yet) — generic label
    expect(labelFor({ status: 'merged', environments }, 'deployed')).toBe('Deployed');
  });

  it('cancelled collapses to received + a cancelled terminal step', () => {
    expect(keysWithState({ status: 'cancelled' })).toEqual([
      'received:done',
      'cancelled:current',
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
      'pending', 'planned', 'in_progress', 'done', 'reviewed', 'merged', 'cancelled',
      'deployed', 'deployed:prod-env-id',
    ];
    for (const status of statuses) {
      expect(() => deriveTicketMilestones({ status })).not.toThrow();
      expect(deriveTicketMilestones({ status }).length).toBeGreaterThan(0);
    }
  });
});
