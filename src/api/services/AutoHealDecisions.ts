/**
 * Pure decision helpers for AutoHealService.
 *
 * Factored out so the core "given these objective signals, what should BE
 * do?" logic can be unit-tested without a live DB or a registered Fly
 * provider. The service wrapper is responsible for gathering the signals
 * and executing the side effects; the functions here make no I/O calls.
 */

import type { MachineState } from './providers/types';

// ---------------------------------------------------------------------------
// Machine state → initial action
// ---------------------------------------------------------------------------

export type MachineStateDecision =
  | 'missing'   // destroyed or being destroyed → 410
  | 'wake'      // stopped/suspended/starting → provider.startMachine or join
  | 'running'   // caller should proceed to /health probe
  | 'transient' // stopping/creating → 503, try again later
  | 'unknown';  // shouldn't happen given the finite MachineState union

export function decideMachineStateAction(state: MachineState): MachineStateDecision {
  switch (state) {
    case 'destroyed':
    case 'destroying':
      return 'missing';
    case 'stopped':
    case 'suspended':
    case 'starting':
      return 'wake';
    case 'running':
      return 'running';
    case 'stopping':
    case 'creating':
      return 'transient';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Running + /health signals → restart decision
// ---------------------------------------------------------------------------

export type RunningHealthDecision =
  | 'no_op'    // workspace is actually fine; no action needed
  | 'restart'  // restart the machine in place
  | 'reprobe'; // probe /health once more before deciding (heartbeat conflict)

export interface RunningHealthInput {
  /** Result of the first machine-targeted /health probe. */
  firstProbeOk: boolean;
  /** true iff the workspace's last heartbeat is within HEARTBEAT_STALE_AFTER_MS. */
  heartbeatFresh: boolean;
  /**
   * Result of the second probe. `null` means it has not happened yet; the
   * caller should do the reprobe and call this function again with the
   * outcome to get a terminal decision.
   */
  secondProbeOk: boolean | null;
}

/**
 * Combines /health probe outcomes with heartbeat freshness to avoid
 * false-positive restarts on transient Fly/proxy failures.
 *
 *   - First probe succeeds                                → no_op
 *   - First probe fails + heartbeat stale                 → restart
 *   - First probe fails + heartbeat fresh + reprobe pending → reprobe
 *   - First probe fails + heartbeat fresh + second succeeds → no_op
 *   - First probe fails + heartbeat fresh + second fails   → restart
 */
export function decideRunningHealthAction(input: RunningHealthInput): RunningHealthDecision {
  if (input.firstProbeOk) return 'no_op';
  if (!input.heartbeatFresh) return 'restart';
  if (input.secondProbeOk === null) return 'reprobe';
  return input.secondProbeOk ? 'no_op' : 'restart';
}

// ---------------------------------------------------------------------------
// Flap detection
// ---------------------------------------------------------------------------

export const FLAP_WINDOW_MS = 15 * 60_000;
export const FLAP_THRESHOLD = 3;

export function isFlapping(recentTerminalAttemptCount: number): boolean {
  return recentTerminalAttemptCount >= FLAP_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Heartbeat freshness
// ---------------------------------------------------------------------------

export const HEARTBEAT_STALE_AFTER_MS = 60_000;

export function isHeartbeatFresh(lastSeen: Date | null, now: number = Date.now()): boolean {
  if (!lastSeen) return false;
  return (now - lastSeen.getTime()) < HEARTBEAT_STALE_AFTER_MS;
}
