/**
 * HealPoller — background worker that waits for a restarted workspace to
 * return healthy and marks the heal attempt succeeded (or failed on timeout).
 *
 * The AutoHealService request handler fires a restart and inserts an
 * in_progress row, then returns 202 immediately. This module runs the /health
 * polling out-of-band so the HTTP request doesn't hang.
 *
 * Respects external completion: if another process or an admin manual restart
 * updates the attempt row to a terminal state, the poller exits quietly.
 *
 * Also exposes buildMachineHealthRequest, shared with AutoHealService's
 * confirmation check — both must target a specific Fly machine via
 * fly-force-instance-id; without that header Fly's shared proxy load-balances
 * across machines in the same app and the /health call can land on the wrong
 * workspace.
 */

import { db } from '../../db/index';
import { serverHealAttempts } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { getProvider } from './providers/registry';
import type { ProviderId } from './providers/types';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;

export interface HealthCheckTarget {
  machineId: string | null;
  serverUrl: string | null;
  provider: string | null;
  // Per-tenant Fly app this workspace lives in. Null for legacy machines on
  // the shared app — `getRoutingInfo` falls back to env-based default in
  // that case. See docs/per-app-isolation-migration.md.
  flyAppName?: string | null;
}

export interface MachineHealthRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the URL + routing headers needed for a machine-targeted /health call.
 *
 * For Fly-hosted workspaces the provider's public URL is a shared *.fly.dev
 * endpoint, and the specific machine is selected via the fly-force-instance-id
 * header. Without that header Fly load-balances across machines and a health
 * probe can land on the wrong workspace.
 *
 * Returns null if we can't build a targetable request (no serverUrl, or
 * machineId missing for a provider that requires routing).
 */
export function buildMachineHealthRequest(target: HealthCheckTarget): MachineHealthRequest | null {
  if (!target.serverUrl) return null;

  let url = target.serverUrl;
  const headers: Record<string, string> = {};

  if (target.machineId) {
    const provider = getProvider((target.provider || 'fly') as ProviderId);
    const routing = provider.getRoutingInfo(target.machineId, target.flyAppName);
    url = routing.serverUrl;
    if (routing.routingToken && routing.requiresRoutingHeaders) {
      headers['fly-force-instance-id'] = routing.routingToken;
    }
  }

  return {
    url: `${url.replace(/\/$/, '')}/health`,
    headers,
  };
}

/**
 * Fire-and-forget: starts an async poll cycle. Returns immediately so the
 * caller's request can complete.
 */
export function startHealPoller(attemptId: string, target: HealthCheckTarget): void {
  void runPoll(attemptId, target).catch((err) => {
    console.error(`[HealPoller] Unhandled error for ${attemptId}:`, err);
  });
}

async function runPoll(attemptId: string, target: HealthCheckTarget): Promise<void> {
  const req = buildMachineHealthRequest(target);
  if (!req) {
    await finalize(attemptId, 'failed', 'no machine routing info available');
    console.warn(`[HealPoller] auto_heal.failed ${JSON.stringify({ attemptId, reason: 'no_target' })}`);
    return;
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    // Bail early if the row transitioned to a terminal state via another path.
    const [row] = await db
      .select({ status: serverHealAttempts.status })
      .from(serverHealAttempts)
      .where(eq(serverHealAttempts.id, attemptId))
      .limit(1);
    if (!row || row.status !== 'in_progress') {
      console.log(`[HealPoller] auto_heal.poll_exit_external ${JSON.stringify({ attemptId, finalStatus: row?.status ?? 'missing' })}`);
      return;
    }

    try {
      const res = await fetch(req.url, {
        headers: req.headers,
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        await finalize(attemptId, 'succeeded', undefined);
        console.log(`[HealPoller] auto_heal.succeeded ${JSON.stringify({ attemptId, durationMs: Date.now() - startedAt })}`);
        return;
      }
      lastError = `/health returned ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const errorMessage = lastError ?? 'health poll timeout after 2 minutes';
  await finalize(attemptId, 'failed', errorMessage);
  console.warn(`[HealPoller] auto_heal.failed ${JSON.stringify({ attemptId, durationMs: Date.now() - startedAt, error: errorMessage })}`);
}

async function finalize(attemptId: string, status: 'succeeded' | 'failed', error?: string): Promise<void> {
  await db
    .update(serverHealAttempts)
    .set({
      status,
      completedAt: new Date(),
      errorMessage: error ?? null,
    })
    .where(and(
      eq(serverHealAttempts.id, attemptId),
      eq(serverHealAttempts.status, 'in_progress'),
    ));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
