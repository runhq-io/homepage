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
 * The track mirrors the runhq lifecycle: done/reviewed → "Reviewed", merged →
 * "Merged", deployed → "Deployed" (each its own step), with pending/planned
 * sharing "Received".
 */
import { describe, it, expect } from 'vitest';
import { deriveTicketMilestones, currentMilestone, currentMilestoneDisplay, type MilestoneInput } from './ticketMilestones';
import { TODO_STATUS_DISPLAY } from '@runhq/server-protocol';

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
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('planned behaves like pending (both map to received)', () => {
    expect(keysWithState({ status: 'planned' })).toEqual([
      'received:current',
      'in_progress:upcoming',
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
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('agent assigned (still pending) advances to in_progress', () => {
    expect(keysWithState({ status: 'pending', agentAssigned: true })).toEqual([
      'received:done',
      'in_progress:current',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('in_progress status', () => {
    expect(keysWithState({ status: 'in_progress' })).toEqual([
      'received:done',
      'in_progress:current',
      'reviewed:upcoming',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('done (PR up, under review): reviewed current', () => {
    expect(keysWithState({ status: 'done' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:current',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('an open PR advances to reviewed even while status is in_progress', () => {
    expect(keysWithState({ status: 'in_progress', prState: 'open' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:current',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('reviewed status: its own step (approved, awaiting merge)', () => {
    expect(keysWithState({ status: 'reviewed' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:current',
      'merged:upcoming',
      'deployed:upcoming',
    ]);
  });

  it('merged status: its own step (landed in base, pre-ship)', () => {
    expect(keysWithState({ status: 'merged' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:done',
      'merged:current',
      'deployed:upcoming',
    ]);
  });

  it('a merged PR advances to the merged step even while status lags', () => {
    expect(keysWithState({ status: 'in_progress', prState: 'merged' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:done',
      'merged:current',
      'deployed:upcoming',
    ]);
  });

  it('deployed (legacy bare): every step done including deployed (terminal complete)', () => {
    expect(keysWithState({ status: 'deployed' })).toEqual([
      'received:done',
      'in_progress:done',
      'reviewed:done',
      'merged:done',
      'deployed:done',
    ]);
  });

  it('deployed:<env> (env-qualified): every step done including deployed (terminal complete)', () => {
    expect(keysWithState({ status: 'deployed:11111111-2222-3333-4444-555555555555' })).toEqual([
      'received:done',
      'in_progress:done',
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

  it('the done step is labelled "Done" (matches the status chip)', () => {
    expect(labelFor({ status: 'done' }, 'in_review')).toBe('Done');
  });

  describe('approval step (requiresApproval)', () => {
    it('is absent for tickets that did not go through the queue', () => {
      expect(keysWithState({ status: 'pending' })).not.toContain('approval:current');
      expect(deriveTicketMilestones({ status: 'in_progress' }).some((m) => m.key === 'approval')).toBe(false);
    });

    it('pending_approval: approval is the current step, labelled "Pending approval"', () => {
      const input: MilestoneInput = { status: 'pending_approval', requiresApproval: true, clarificationStatus: 'skipped' };
      expect(keysWithState(input)).toEqual([
        'received:done',
        'clarifying:done',
        'approval:current',
        'in_progress:upcoming',
        'in_review:upcoming',
        'reviewed:upcoming',
        'merged:upcoming',
        'deployed:upcoming',
      ]);
      expect(labelFor(input, 'approval')).toBe('Pending approval');
    });

    it('pending_approval pins at the gate even with a skipped clarifier (not In progress)', () => {
      // Regression: the chat "skipped" clarifier used to pull the marker to In progress.
      const input: MilestoneInput = { status: 'pending_approval', requiresApproval: true, clarificationStatus: 'skipped' };
      const current = deriveTicketMilestones(input).find((m) => m.state === 'current');
      expect(current?.key).toBe('approval');
    });

    it('approved (planned) with no work yet: approval done+"Approved", In progress current', () => {
      const input: MilestoneInput = { status: 'planned', requiresApproval: true };
      expect(keysWithState(input)).toEqual([
        'received:done',
        'approval:done',
        'in_progress:current',
        'in_review:upcoming',
        'reviewed:upcoming',
        'merged:upcoming',
        'deployed:upcoming',
      ]);
      expect(labelFor(input, 'approval')).toBe('Approved');
    });

    it('approved + further advanced keeps approval "Approved" (done)', () => {
      const input: MilestoneInput = { status: 'done', requiresApproval: true, clarificationStatus: 'skipped' };
      expect(labelFor(input, 'approval')).toBe('Approved');
      expect(keysWithState(input)).toContain('approval:done');
      expect(keysWithState(input)).toContain('in_review:current'); // "Done" step is current
    });
  });

  it('every milestone carries a non-empty human label', () => {
    for (const m of deriveTicketMilestones({ status: 'in_progress', clarificationStatus: 'asking', prState: 'open' })) {
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it('is total: never throws for any status value', () => {
    const statuses: MilestoneInput['status'][] = [
      'pending', 'pending_approval', 'planned', 'in_progress', 'done', 'reviewed', 'merged', 'cancelled',
      'deployed', 'deployed:prod-env-id',
    ];
    for (const status of statuses) {
      expect(() => deriveTicketMilestones({ status })).not.toThrow();
      expect(deriveTicketMilestones({ status }).length).toBeGreaterThan(0);
    }
  });
});

describe('currentMilestone / currentMilestoneDisplay — single source of truth for the chip', () => {
  it('an open PR on an in_progress ticket reports the PR-aware step (the reported bug)', () => {
    // The exact discrepancy: status is still in_progress, but the linked PR is
    // open. The stepper advances to the review step, and the chip MUST follow it
    // — not report the stale "In progress".
    const cur = currentMilestone({ status: 'in_progress', prState: 'open' });
    expect(cur.key).toBe('in_review');
    // The chip label matches the stepper's, and borrows the `done` palette.
    const disp = currentMilestoneDisplay({ status: 'in_progress', prState: 'open' });
    expect(disp.key).toBe('in_review');
    expect(disp.label).toBe(cur.label);
    expect(disp.dot).toBe(TODO_STATUS_DISPLAY.done.dot);
  });

  it('without a PR, an in_progress ticket reads in_progress', () => {
    const disp = currentMilestoneDisplay({ status: 'in_progress' });
    expect(disp.key).toBe('in_progress');
    expect(disp.dot).toBe(TODO_STATUS_DISPLAY.in_progress.dot);
  });

  it('a pending_approval ticket reports the approval step', () => {
    const disp = currentMilestoneDisplay({ status: 'pending_approval', requiresApproval: true });
    expect(disp.key).toBe('approval');
    expect(disp.dot).toBe(TODO_STATUS_DISPLAY.pending_approval.dot);
  });

  it('a deployed ticket reports the (terminal) deploy step with the env label + color', () => {
    const disp = currentMilestoneDisplay({ status: 'deployed:prod', environments: [{ id: 'prod', name: 'Production' }] });
    expect(disp.key).toBe('deployed');
    expect(disp.label).toBe('Deployed → Production');
    expect(disp.dot).toBe(TODO_STATUS_DISPLAY.deployed.dot);
  });

  it('a cancelled ticket reports the cancelled step', () => {
    const disp = currentMilestoneDisplay({ status: 'cancelled' });
    expect(disp.key).toBe('cancelled');
    expect(disp.dot).toBe(TODO_STATUS_DISPLAY.cancelled.dot);
  });

  it('is total: returns a labelled, colored step for every status', () => {
    const statuses: MilestoneInput['status'][] = [
      'pending', 'pending_approval', 'planned', 'in_progress', 'done', 'reviewed', 'merged', 'cancelled',
      'deployed', 'deployed:prod-env-id',
    ];
    for (const status of statuses) {
      const disp = currentMilestoneDisplay({ status });
      expect(disp.label.length).toBeGreaterThan(0);
      expect(disp.dot).toMatch(/^#/);
    }
  });
});
