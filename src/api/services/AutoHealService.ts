/**
 * AutoHealService — workspace recovery orchestration.
 *
 * Non-admin members CANNOT trigger a restart directly. Instead, they send a
 * "report unreachable" signal, and BE decides what action (if any) is
 * warranted based on objective signals:
 *
 *   - Provider machine state (stopped / suspended / running / destroyed)
 *   - Machine-targeted /health probe (via fly-force-instance-id routing)
 *   - Heartbeat staleness (diagnostic, not a decision gate)
 *
 * Possible BE actions:
 *   - `no_op`        — /health ok; workspace is actually up; nothing to do
 *   - `join_existing`— an in_progress heal already exists; client joins it
 *   - `wake`         — machine stopped/suspended; start it (Fly auto-suspend path)
 *   - `restart`      — machine running but /health fails; in-place restart
 *   - `flapping`     — 3+ terminal attempts in 15 min; refuse to act
 *   - `missing`      — machine destroyed or record incomplete
 *
 * Admin-initiated manual restart still lives in ServerService.restartRemoteServer
 * and is admin/owner-gated. This endpoint never exposes a raw "restart" to
 * non-admin members — BE is the sole decision-maker for wake vs restart vs
 * no-op. A member with a transient local network issue cannot bounce the
 * workspace for everyone because the running+/health-ok path short-circuits.
 *
 * Concurrency: partial unique index on (server_id) WHERE status='in_progress'
 * enforces at-most-one-in-flight heal per server at the DB level. Two
 * racing signals both pass logical checks; one insert wins, the other
 * reads the existing row and both clients converge on the same attemptId.
 */

import { db } from '../../db/index';
import { serverMembers, serverHealAttempts, servers } from '../../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { getProvider } from './providers/registry';
import type { ProviderId, MachineState } from './providers/types';
import { startHealPoller, buildMachineHealthRequest } from './HealPoller';
import {
  decideMachineStateAction,
  decideRunningHealthAction,
  isFlapping,
  isHeartbeatFresh,
  FLAP_WINDOW_MS,
} from './AutoHealDecisions';

const CONFIRMATION_HEALTH_TIMEOUT_MS = 10_000;
/** Delay between the first and second /health probes when the workspace still has a fresh heartbeat. */
const RECONFIRM_DELAY_MS = 3_000;

export type HealAction =
  | 'no_op'
  | 'join_existing'
  | 'wake'
  | 'restart'
  | 'flapping'
  | 'missing'
  | 'provider_unavailable'
  | 'forbidden';

export interface ReportUnreachableRequest {
  serverId: string;
  userId: string;
}

export interface ReportUnreachableResponse {
  status: number;
  body: {
    action: HealAction;
    attemptId?: string;
    /**
     * True if the server-observed signal disagrees with what the client
     * reported. Diagnostic; client doesn't typically branch on this.
     */
    heartbeatFresh?: boolean;
  };
}

/**
 * Member-auth recovery signal. BE decides the action from objective state;
 * no raw "restart" is exposed to non-admin members.
 */
export async function reportUnreachable(req: ReportUnreachableRequest): Promise<ReportUnreachableResponse> {
  const { serverId, userId } = req;

  // Membership check — any authenticated member may signal unreachability.
  // The decision about whether to actually act belongs to BE, not the caller.
  const [member] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!member) {
    logEvent('auto_heal.forbidden', { serverId, userId });
    return { status: 403, body: { action: 'forbidden' } };
  }

  // Join an in-progress attempt.
  const [inProgress] = await db
    .select({ id: serverHealAttempts.id })
    .from(serverHealAttempts)
    .where(and(
      eq(serverHealAttempts.serverId, serverId),
      eq(serverHealAttempts.status, 'in_progress'),
    ))
    .limit(1);
  if (inProgress) {
    logEvent('auto_heal.joined_in_progress', { serverId, userId, attemptId: inProgress.id });
    return { status: 202, body: { action: 'join_existing', attemptId: inProgress.id } };
  }

  // Flap check — count only completed (terminal) attempts in the window.
  const windowStart = new Date(Date.now() - FLAP_WINDOW_MS);
  const recentTerminal = await db
    .select({ id: serverHealAttempts.id })
    .from(serverHealAttempts)
    .where(and(
      eq(serverHealAttempts.serverId, serverId),
      gte(serverHealAttempts.startedAt, windowStart),
      inArray(serverHealAttempts.status, ['succeeded', 'failed']),
    ));
  if (isFlapping(recentTerminal.length)) {
    logEvent('auto_heal.flap_detected', {
      serverId,
      userId,
      attemptCount: recentTerminal.length,
      windowMs: FLAP_WINDOW_MS,
    });
    return { status: 409, body: { action: 'flapping' } };
  }

  // Load server.
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server || !server.machineId || !server.serverUrl) {
    logEvent('auto_heal.missing', { serverId, userId, reason: !server ? 'no_server' : !server.machineId ? 'no_machine_id' : 'no_server_url' });
    return { status: 410, body: { action: 'missing' } };
  }

  // Refuse to heal during structural provisioning (migration / region change /
  // tier change / fresh provision). The runner has explicitly stopped the
  // machine and disabled autostart; an autoheal-triggered startMachine would
  // race-restart it mid-snapshot and corrupt the migration target volume.
  // Same gate applied to wakeRemoteServerInternal — see ServerService.ts.
  //
  // Also gate on `migrationInProgress`: heartbeat / register handlers can
  // clobber status='provisioning' to 'online' during migration (a process
  // inside the workspace machine raced our stopMachine and reported
  // presence). The dedicated boolean column survives that clobber.
  if (server.status === 'provisioning' || server.migrationInProgress) {
    logEvent('auto_heal.skipped_provisioning', { serverId, userId });
    return { status: 503, body: { action: 'provider_unavailable' } };
  }

  const provider = getProvider((server.provider || 'fly') as ProviderId);

  // Objective signal #1: what does the provider think the machine is doing?
  let machineState: MachineState;
  try {
    machineState = await provider.getMachineState(server.machineId, server.flyAppName);
  } catch (err) {
    const errMsg = String(err);
    const is404 = /\b404\b/.test(errMsg);
    if (is404) {
      logEvent('auto_heal.machine_missing', { serverId, userId, error: errMsg });
      return { status: 410, body: { action: 'missing' } };
    }
    logEvent('auto_heal.provider_unavailable', { serverId, userId, stage: 'getMachineState', error: errMsg });
    return { status: 503, body: { action: 'provider_unavailable' } };
  }

  const heartbeatFresh = isHeartbeatFresh(server.lastSeen);
  const stateDecision = decideMachineStateAction(machineState);

  if (stateDecision === 'missing') {
    logEvent('auto_heal.missing', { serverId, userId, machineState });
    return { status: 410, body: { action: 'missing' } };
  }

  if (stateDecision === 'wake') {
    const alreadyStarting = machineState === 'starting';
    return await startAttempt({
      serverId,
      userId,
      action: 'wake',
      heartbeatFresh,
      machineState,
      serverUrl: server.serverUrl,
      machineId: server.machineId,
      provider: server.provider,
      flyAppName: server.flyAppName,
      // If already starting, no provider call — just open an attempt row
      // so the poller watches it come online. Otherwise issue startMachine
      // for stopped/suspended (Fly auto-suspend path).
      run: alreadyStarting
        ? async () => { /* already starting */ }
        : () => provider.startMachine(server.machineId!, server.flyAppName),
    });
  }

  if (stateDecision === 'transient' || stateDecision === 'unknown') {
    logEvent('auto_heal.transient_state', { serverId, userId, machineState });
    return { status: 503, body: { action: 'provider_unavailable', heartbeatFresh } };
  }

  // Machine is running. Combine two objective signals:
  //   1. Machine-targeted /health probe (via fly-force-instance-id)
  //   2. Heartbeat staleness (server.lastSeen from workspace's 30s ping)
  //
  // Decision tree (decideRunningHealthAction):
  //   - probe ok                                     → no_op
  //   - probe fails + stale heartbeat                → restart (both signals agree)
  //   - probe fails + fresh heartbeat                → reprobe after 3s
  //   - probe fails + fresh heartbeat + reprobe ok   → no_op (transient blip)
  //   - probe fails + fresh heartbeat + reprobe fail → restart
  const healthTarget = {
    machineId: server.machineId,
    serverUrl: server.serverUrl,
    provider: server.provider,
    flyAppName: server.flyAppName,
  };
  const firstProbeOk = await confirmHealthy(healthTarget);

  let firstStep = decideRunningHealthAction({ firstProbeOk, heartbeatFresh, secondProbeOk: null });
  let probes = 1;
  let secondProbeOk: boolean | null = null;

  if (firstStep === 'reprobe') {
    await sleep(RECONFIRM_DELAY_MS);
    secondProbeOk = await confirmHealthy(healthTarget);
    firstStep = decideRunningHealthAction({ firstProbeOk, heartbeatFresh, secondProbeOk });
    probes = 2;
  }

  if (firstStep === 'no_op') {
    logEvent('auto_heal.confirmed_healthy', { serverId, userId, heartbeatFresh, probes });
    return { status: 200, body: { action: 'no_op', heartbeatFresh } };
  }

  // firstStep === 'restart' (the only remaining value at this point)
  const reason = heartbeatFresh ? 'double_probe_failed' : 'stale_heartbeat';
  logEvent('auto_heal.decision_restart', { serverId, userId, heartbeatFresh, probes, reason });
  return await startAttempt({
    serverId,
    userId,
    action: 'restart',
    heartbeatFresh,
    machineState,
    serverUrl: server.serverUrl,
    machineId: server.machineId,
    provider: server.provider,
    flyAppName: server.flyAppName,
    run: () => provider.restartMachine(server.machineId!, server.flyAppName),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminal-state lookup for a single heal attempt. Used by the client to
 * exit its `healing` state deterministically instead of relying on a
 * watchdog timeout.
 */
export interface HealAttemptStatus {
  id: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export async function getHealAttemptStatus(
  serverId: string,
  userId: string,
  attemptId: string,
): Promise<{ status: number; body: HealAttemptStatus | { error: string } }> {
  const [member] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!member) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const [row] = await db
    .select()
    .from(serverHealAttempts)
    .where(and(
      eq(serverHealAttempts.id, attemptId),
      eq(serverHealAttempts.serverId, serverId),
    ))
    .limit(1);
  if (!row) {
    return { status: 404, body: { error: 'attempt_not_found' } };
  }

  return {
    status: 200,
    body: {
      id: row.id,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
      errorMessage: row.errorMessage ?? undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StartAttemptInput {
  serverId: string;
  userId: string;
  action: 'wake' | 'restart';
  heartbeatFresh: boolean;
  machineState: MachineState;
  serverUrl: string;
  machineId: string;
  provider: string | null;
  flyAppName?: string | null;
  run: () => Promise<void>;
}

/**
 * Insert an in_progress row, run the provider action, spawn the poller.
 * Returns a 202 response body describing the action taken. On insert race,
 * returns the existing attempt's ID (loser semantics).
 */
async function startAttempt(input: StartAttemptInput): Promise<ReportUnreachableResponse> {
  const { serverId, userId, action, heartbeatFresh, machineState, serverUrl, machineId } = input;

  let attemptId: string;
  try {
    const [inserted] = await db
      .insert(serverHealAttempts)
      .values({
        serverId,
        triggeredBy: userId,
        status: 'in_progress',
      })
      .returning({ id: serverHealAttempts.id });
    attemptId = inserted.id;
  } catch (err) {
    // Partial unique index — race lost.
    const [winner] = await db
      .select({ id: serverHealAttempts.id })
      .from(serverHealAttempts)
      .where(and(
        eq(serverHealAttempts.serverId, serverId),
        eq(serverHealAttempts.status, 'in_progress'),
      ))
      .limit(1);
    if (winner) {
      return { status: 202, body: { action: 'join_existing', attemptId: winner.id, heartbeatFresh } };
    }
    console.error(`[AutoHeal] ${serverId}: insert failed with no in_progress winner`, err);
    throw err;
  }

  try {
    logEvent('auto_heal.triggered', { serverId, userId, attemptId, action, machineState, heartbeatFresh });
    await input.run();
  } catch (err) {
    const errMsg = String(err);
    const is404 = /\b404\b/.test(errMsg);
    await markFailed(attemptId, errMsg);
    if (is404) {
      logEvent('auto_heal.machine_missing', { serverId, userId, attemptId, error: errMsg });
      return { status: 410, body: { action: 'missing', attemptId } };
    }
    logEvent('auto_heal.provider_unavailable', { serverId, userId, attemptId, action, error: errMsg });
    return { status: 503, body: { action: 'provider_unavailable', attemptId } };
  }

  startHealPoller(attemptId, {
    machineId,
    serverUrl,
    provider: input.provider,
    flyAppName: input.flyAppName,
  });
  return { status: 202, body: { action, attemptId, heartbeatFresh } };
}

async function confirmHealthy(server: {
  machineId: string | null;
  serverUrl: string | null;
  provider: string | null;
  flyAppName?: string | null;
}): Promise<boolean> {
  const req = buildMachineHealthRequest(server);
  if (!req) return false;
  try {
    const res = await fetch(req.url, {
      headers: req.headers,
      signal: AbortSignal.timeout(CONFIRMATION_HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function markFailed(attemptId: string, errorMessage: string): Promise<void> {
  await db
    .update(serverHealAttempts)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorMessage: errorMessage.slice(0, 1000),
    })
    .where(and(
      eq(serverHealAttempts.id, attemptId),
      eq(serverHealAttempts.status, 'in_progress'),
    ));
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(`[AutoHeal] ${event} ${JSON.stringify(fields)}`);
}
