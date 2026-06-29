/**
 * ticketMilestones.ts — derives the partner-facing progress stepper.
 *
 * This is the ONLY representation of agent/ticket progress exposed to external
 * widget users. By taking nothing but a status enum, the clarification status,
 * an agent-assigned flag, and the PR *state* (never URL/code), it is
 * structurally incapable of leaking code, file paths, or agent internals.
 *
 * The function is pure and total — every status value yields a non-empty,
 * ordered list of milestones.
 */

import { isDeployedStatus } from '@runhq/server-protocol';

export type TicketStatus =
  | 'pending'
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'reviewed'
  | 'merged'
  | 'cancelled'
  | 'deployed'
  | `deployed:${string}`;

export type ClarificationStatus = 'asking' | 'ready' | 'skipped' | 'duplicate' | 'started';

export type PrState = 'open' | 'closed' | 'merged';

export interface MilestoneInput {
  status: TicketStatus;
  /** Most recent clarification session status, if any. */
  clarificationStatus?: ClarificationStatus | null;
  /** True once any agent has been assigned to the ticket. */
  agentAssigned?: boolean;
  /** State of the linked PR, if any. We use only the state — never the URL. */
  prState?: PrState | null;
}

export type MilestoneState = 'done' | 'current' | 'upcoming';

export interface Milestone {
  key: string;
  label: string;
  state: MilestoneState;
}

/** Absolute position of each step on the canonical linear track. */
const TRACK = {
  received: 0,
  clarifying: 1,
  in_progress: 2,
  in_review: 3,
  shipped: 4,
} as const;

const LABELS: Record<string, string> = {
  received: 'Received',
  clarifying: 'Clarifying',
  in_progress: 'In progress',
  in_review: 'In review',
  shipped: 'Shipped',
  closed: 'Closed',
};

/**
 * How far the ticket has progressed along the canonical track, as the index of
 * the furthest-reached step. Computed as the max across every progress signal so
 * a later signal (e.g. an open PR) always wins over an earlier status.
 */
function reachedIndex(input: MilestoneInput): number {
  let statusReached: number = TRACK.received;
  if (isDeployedStatus(input.status)) {
    // Any deploy status (legacy bare `deployed` or env-qualified `deployed:<env>`).
    statusReached = TRACK.shipped;
  } else {
    switch (input.status) {
      case 'in_progress':
        statusReached = TRACK.in_progress;
        break;
      case 'done':       // PR up, awaiting review
      case 'reviewed':   // approved
      case 'merged':     // landed in base, pre-ship
        statusReached = TRACK.in_review;
        break;
      // pending / planned → received
    }
  }

  let clarReached: number = TRACK.received;
  if (input.clarificationStatus === 'asking') {
    clarReached = TRACK.clarifying;
  } else if (input.clarificationStatus) {
    // ready / started / skipped / duplicate → clarification resolved, work begins
    clarReached = TRACK.in_progress;
  }

  const agentReached = input.agentAssigned ? TRACK.in_progress : TRACK.received;
  const prReached = input.prState ? TRACK.in_review : TRACK.received;

  return Math.max(statusReached, clarReached, agentReached, prReached);
}

function step(key: keyof typeof TRACK, reached: number, complete: boolean): Milestone {
  const index = TRACK[key];
  let state: MilestoneState;
  if (index < reached) state = 'done';
  else if (index === reached) state = complete ? 'done' : 'current';
  else state = 'upcoming';
  return { key, label: LABELS[key], state };
}

export function deriveTicketMilestones(input: MilestoneInput): Milestone[] {
  // Cancelled is a terminal alternate: the work was received, then closed.
  if (input.status === 'cancelled') {
    return [
      { key: 'received', label: LABELS.received, state: 'done' },
      { key: 'closed', label: LABELS.closed, state: 'current' },
    ];
  }

  const reached = reachedIndex(input);
  const complete = isDeployedStatus(input.status);

  const milestones: Milestone[] = [step('received', reached, complete)];
  // The clarifying step appears only when a clarification session exists.
  if (input.clarificationStatus) {
    milestones.push(step('clarifying', reached, complete));
  }
  milestones.push(step('in_progress', reached, complete));
  milestones.push(step('in_review', reached, complete));
  milestones.push(step('shipped', reached, complete));

  return milestones;
}
