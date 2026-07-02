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

import { isDeployedStatus, deployedEnvId, TODO_STATUS_DISPLAY } from '@runhq/server-protocol';

export type TicketStatus =
  | 'pending'
  | 'pending_approval'
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
  /**
   * Deploy-environment id→name map for the project, used only to resolve a
   * `deployed:<envId>` status to a human label ("Deployed → Production").
   * Empty/omitted ⇒ the deploy step falls back to the bare "Deployed" label.
   */
  environments?: Array<{ id: string; name: string }>;
  /**
   * True when the ticket went through the approval queue — currently
   * `pending_approval`, or born into it and since approved. Inserts a dedicated
   * approval step (after Clarifying) that reads "Pending approval" while active
   * and "Approved" once the marker has advanced past it.
   */
  requiresApproval?: boolean;
}

export type MilestoneState = 'done' | 'current' | 'upcoming';

export interface Milestone {
  key: string;
  label: string;
  state: MilestoneState;
}

/**
 * Absolute position of each step on the canonical linear track. Mirrors the
 * runhq lifecycle statuses: the internal `done`/`reviewed`/`merged`/`deployed`
 * states each get their own partner-facing step (previously all collapsed into
 * "In review" / "Shipped"). `pending` + `planned` still share "Received".
 */
const TRACK = {
  received: 0,
  clarifying: 1,
  approval: 2,
  in_progress: 3,
  in_review: 4,
  reviewed: 5,
  merged: 6,
  deployed: 7,
} as const;

const LABELS: Record<string, string> = {
  received: 'Received',
  clarifying: 'Clarifying',
  // The approval step's label is resolved dynamically in deriveTicketMilestones
  // ("Pending approval" while active → "Approved" once passed); this is the
  // fallback.
  approval: 'Pending approval',
  in_progress: 'In progress',
  // The `done` status ("PR up, awaiting review") — labelled "Done" for partners
  // to match the status chip (TODO_STATUS_DISPLAY.done). The `reviewed` step
  // that follows covers the review milestone.
  in_review: 'Done',
  reviewed: 'Reviewed',
  merged: 'Merged',
  deployed: 'Deployed',
  cancelled: 'Cancelled',
};

/**
 * Label for the deploy step. Resolves an env-qualified `deployed:<envId>` status
 * to "Deployed → <name>" when the project's environment map is available; every
 * other case (upcoming step, legacy bare `deployed`, unknown env) uses the bare
 * "Deployed" label. Never leaks the raw env id.
 */
function deployedLabel(status: string, environments: Array<{ id: string; name: string }>): string {
  const envId = deployedEnvId(status);
  if (envId) {
    const env = environments.find((e) => e.id === envId);
    if (env) return `${LABELS.deployed} → ${env.name}`;
  }
  return LABELS.deployed;
}

/**
 * How far the ticket has progressed along the canonical track, as the index of
 * the furthest-reached step. Computed as the max across every progress signal so
 * a later signal (e.g. an open PR) always wins over an earlier status.
 */
function reachedIndex(input: MilestoneInput): number {
  // Approval gate. A ticket still awaiting approval is pinned at the approval
  // step regardless of clarifier/agent/PR signals (chat-created tickets carry a
  // 'skipped' clarification marker that would otherwise read as "In progress").
  if (input.status === 'pending_approval') return TRACK.approval;

  let statusReached: number = TRACK.received;
  if (isDeployedStatus(input.status)) {
    // Any deploy status (legacy bare `deployed` or env-qualified `deployed:<env>`).
    statusReached = TRACK.deployed;
  } else {
    switch (input.status) {
      case 'in_progress':
        statusReached = TRACK.in_progress;
        break;
      case 'done':       // PR up, under review
        statusReached = TRACK.in_review;
        break;
      case 'reviewed':   // approved, awaiting merge
        statusReached = TRACK.reviewed;
        break;
      case 'merged':     // landed in base, pre-ship
        statusReached = TRACK.merged;
        break;
      // pending / pending_approval / planned → received
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
  // An open/closed PR means the work is at least under review; a merged PR
  // means it has landed in the base branch.
  const prReached =
    input.prState === 'merged' ? TRACK.merged :
    input.prState ? TRACK.in_review :
    TRACK.received;

  const reached = Math.max(statusReached, clarReached, agentReached, prReached);

  // An approved ticket that went through the queue (requiresApproval but no
  // longer pending_approval) sits at least at the work phase, so its approval
  // step reads "Approved" (done) and the active marker moves past the gate.
  if (input.requiresApproval) return Math.max(reached, TRACK.in_progress);
  return reached;
}

function step(key: keyof typeof TRACK, reached: number, complete: boolean): Milestone {
  const index = TRACK[key];
  let state: MilestoneState;
  if (index < reached) state = 'done';
  else if (index === reached) state = complete ? 'done' : 'current';
  else state = 'upcoming';
  return { key, label: LABELS[key], state };
}

/**
 * Which status-registry entry each milestone step borrows its chip colors from.
 * The milestone track has steps the raw status vocabulary lacks (received /
 * clarifying / in_review), so we map them onto the closest canonical status so
 * the partner-facing chip stays visually consistent with the rest of the UI.
 * `in_review` borrows `done` ("PR up, under review"); `received`/`clarifying`
 * borrow the pending/pending_approval palette.
 */
const MILESTONE_COLOR_KEY: Record<string, keyof typeof TODO_STATUS_DISPLAY> = {
  received: 'pending',
  clarifying: 'pending_approval',
  approval: 'pending_approval',
  in_progress: 'in_progress',
  in_review: 'done',
  reviewed: 'reviewed',
  merged: 'merged',
  deployed: 'deployed',
  cancelled: 'cancelled',
};

/** The partner-facing progress chip: a milestone plus the colors it renders in. */
export interface CurrentMilestone {
  key: string;
  label: string;
  dot: string;
  bg: string;
  fg: string;
}

/**
 * The single milestone that represents "where the ticket is right now" — the
 * `current` step, or (for terminal states with no current step, e.g. a fully
 * `deployed` ticket) the furthest step. This is the ONE progress signal every
 * partner-facing surface should show, so the list chip, the detail chip, and
 * the detail stepper can never disagree.
 */
export function currentMilestone(input: MilestoneInput): Milestone {
  const milestones = deriveTicketMilestones(input);
  const current = milestones.find((m) => m.state === 'current');
  return current ?? milestones[milestones.length - 1];
}

/** {@link currentMilestone} plus the chip colors, ready for a customer-facing UI. */
export function currentMilestoneDisplay(input: MilestoneInput): CurrentMilestone {
  const m = currentMilestone(input);
  const colorKey = MILESTONE_COLOR_KEY[m.key] ?? 'pending';
  const disp = TODO_STATUS_DISPLAY[colorKey];
  return { key: m.key, label: m.label, dot: disp.dot, bg: disp.bg, fg: disp.fg };
}

export function deriveTicketMilestones(input: MilestoneInput): Milestone[] {
  // Cancelled is a terminal alternate: the work was received, then cancelled.
  if (input.status === 'cancelled') {
    return [
      { key: 'received', label: LABELS.received, state: 'done' },
      { key: 'cancelled', label: LABELS.cancelled, state: 'current' },
    ];
  }

  const reached = reachedIndex(input);
  const complete = isDeployedStatus(input.status);

  const milestones: Milestone[] = [step('received', reached, complete)];
  // The clarifying step appears only when a clarification session exists.
  if (input.clarificationStatus) {
    milestones.push(step('clarifying', reached, complete));
  }
  // The approval step appears only for tickets that went through the approval
  // queue. Its label is state-driven: "Pending approval" while it is the active
  // (current/upcoming) step, "Approved" once the marker has advanced past it.
  if (input.requiresApproval) {
    const approval = step('approval', reached, complete);
    approval.label = approval.state === 'done' ? 'Approved' : 'Pending approval';
    milestones.push(approval);
  }
  milestones.push(step('in_progress', reached, complete));
  milestones.push(step('in_review', reached, complete));
  milestones.push(step('reviewed', reached, complete));
  milestones.push(step('merged', reached, complete));

  // The final deploy step resolves the environment name when the ticket is
  // actually deployed (deployed:<env>); otherwise it reads a bare "Deployed".
  const deployed = step('deployed', reached, complete);
  deployed.label = deployedLabel(input.status, input.environments ?? []);
  milestones.push(deployed);

  return milestones;
}
