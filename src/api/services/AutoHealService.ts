/**
 * AutoHealService — handles auto-heal requests from clients whose workspace
 * has become unreachable.
 *
 * Flow:
 *   1. Membership check (any server_members row; no admin required)
 *   2. If an in_progress heal row already exists for this server, return its
 *      attemptId — don't fire another restart
 *   3. Flap check: ≥3 completed attempts in the last 15 minutes → 409 flapping
 *   4. Confirmation health check: one 10s /health call from BE. If it
 *      responds 200, the workspace is actually up (client-local false
 *      positive) — return 200 healthy without restarting
 *   5. Insert in_progress row (partial unique index enforces at most one)
 *   6. Call provider.restartMachine (the native Fly restart — not updateImage)
 *   7. Start background HealPoller to mark succeeded/failed when /health
 *      returns or the 2-minute deadline elapses
 *
 * Concurrency: the partial unique index on (server_id) WHERE status = 'in_progress'
 * prevents two in-flight heals. Two racing requests: loser's insert fails
 * on conflict, loser reads the existing row, both clients poll the same
 * attemptId.
 *
 * Restart flavor: uses provider.restartMachine (in-place) rather than
 * updateMachineImage. Auto-heal is about restoring a crashed process; pulling
 * a fresh image onto a sick machine would risk making it worse and slow the
 * recovery. The settings-page manual restart button continues to call
 * updateMachineImage for its "restart + pick up latest deploy" semantics.
 */

import { db } from '../../db/index';
import { serverMembers, serverHealAttempts, servers } from '../../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { getProvider } from './providers/registry';
import type { ProviderId } from './providers/types';
import { startHealPoller } from './HealPoller';

const FLAP_WINDOW_MS = 15 * 60_000;
const FLAP_THRESHOLD = 3;
const CONFIRMATION_HEALTH_TIMEOUT_MS = 10_000;

export interface AutoHealRequest {
  serverId: string;
  userId: string;
}

export interface AutoHealResponse {
  status: number;
  body: {
    status: 'healthy' | 'in_progress' | 'restarting' | 'flapping' | 'provider_unavailable' | 'missing' | 'forbidden';
    attemptId?: string;
  };
}

/**
 * Request an auto-heal for a workspace. See module doc for flow.
 * Caller is expected to have already authenticated the user; this function
 * performs the membership check against server_members.
 */
export async function requestAutoHeal(req: AutoHealRequest): Promise<AutoHealResponse> {
  const { serverId, userId } = req;

  // Membership check — any authenticated member can trigger auto-heal.
  // No admin check: restoring a crashed service isn't a disruptive action.
  const [member] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  if (!member) {
    logEvent('auto_heal.forbidden', { serverId, userId });
    return { status: 403, body: { status: 'forbidden' } };
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
    return { status: 202, body: { status: 'in_progress', attemptId: inProgress.id } };
  }

  // Flap check — count only completed (terminal) attempts in the window.
  // An active in_progress row would have short-circuited above, so this
  // counts distinct restart cycles, not request attempts.
  const windowStart = new Date(Date.now() - FLAP_WINDOW_MS);
  const recentTerminal = await db
    .select({ id: serverHealAttempts.id })
    .from(serverHealAttempts)
    .where(and(
      eq(serverHealAttempts.serverId, serverId),
      gte(serverHealAttempts.startedAt, windowStart),
      inArray(serverHealAttempts.status, ['succeeded', 'failed']),
    ));
  if (recentTerminal.length >= FLAP_THRESHOLD) {
    // Flap detected — refuse to restart and emit a structured event. Real
    // user-facing in-app notifications require a notification service that
    // doesn't yet exist in this codebase; the event is visible in logs and
    // a future NotificationService can subscribe to it.
    logEvent('auto_heal.flap_detected', {
      serverId,
      userId,
      attemptCount: recentTerminal.length,
      windowMs: FLAP_WINDOW_MS,
    });
    return { status: 409, body: { status: 'flapping' } };
  }

  // Load server; confirm machine is known.
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server || !server.machineId || !server.serverUrl) {
    logEvent('auto_heal.missing', { serverId, userId, reason: !server ? 'no_server' : !server.machineId ? 'no_machine_id' : 'no_server_url' });
    return { status: 410, body: { status: 'missing' } };
  }

  // Confirmation health check (BE's independent path to the workspace).
  // False positives from the client side (laptop sleep, network switch) are
  // filtered here — if BE can reach /health, the workspace isn't really dead.
  if (await confirmHealthy(server.serverUrl)) {
    logEvent('auto_heal.confirmed_healthy', { serverId, userId });
    return { status: 200, body: { status: 'healthy' } };
  }

  // Insert in_progress row. Partial unique index on (server_id) WHERE status='in_progress'
  // enforces the at-most-one invariant — racing requests converge here.
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
    // Likely the partial unique index — another request won the race.
    const [winner] = await db
      .select({ id: serverHealAttempts.id })
      .from(serverHealAttempts)
      .where(and(
        eq(serverHealAttempts.serverId, serverId),
        eq(serverHealAttempts.status, 'in_progress'),
      ))
      .limit(1);
    if (winner) {
      return { status: 202, body: { status: 'in_progress', attemptId: winner.id } };
    }
    // Genuinely unexpected insert failure.
    console.error(`[AutoHeal] ${serverId}: insert failed and no in_progress winner found`, err);
    throw err;
  }

  // Fire the Fly restart.
  try {
    const provider = getProvider((server.provider || 'fly') as ProviderId);
    logEvent('auto_heal.triggered', { serverId, userId, attemptId, machineId: server.machineId });
    await provider.restartMachine(server.machineId);
  } catch (err) {
    const errMsg = String(err);
    const is404 = /\b404\b/.test(errMsg);
    await markFailed(attemptId, errMsg);
    if (is404) {
      logEvent('auto_heal.machine_missing', { serverId, userId, attemptId, error: errMsg });
      return { status: 410, body: { status: 'missing', attemptId } };
    }
    logEvent('auto_heal.provider_unavailable', { serverId, userId, attemptId, error: errMsg });
    return { status: 503, body: { status: 'provider_unavailable', attemptId } };
  }

  // Start async poller to finalize the attempt when /health recovers.
  startHealPoller(attemptId, server.serverUrl);

  return { status: 202, body: { status: 'restarting', attemptId } };
}

/**
 * Structured event log. One line per event, JSON-parseable tail, for log
 * aggregators and future dashboards. Prefixed with a tag so it's greppable
 * when scanning raw logs.
 */
function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(`[AutoHeal] ${event} ${JSON.stringify(fields)}`);
}

async function confirmHealthy(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`, {
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
