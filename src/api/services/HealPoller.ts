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
 */

import { db } from '../../db/index';
import { serverHealAttempts } from '../../db/schema';
import { and, eq } from 'drizzle-orm';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Fire-and-forget: starts an async poll cycle. Returns immediately so the
 * caller's request can complete.
 */
export function startHealPoller(attemptId: string, serverUrl: string): void {
  void runPoll(attemptId, serverUrl).catch((err) => {
    console.error(`[HealPoller] Unhandled error for ${attemptId}:`, err);
  });
}

async function runPoll(attemptId: string, serverUrl: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    // Bail early if the row transitioned to a terminal state via another path.
    const [row] = await db
      .select({ status: serverHealAttempts.status })
      .from(serverHealAttempts)
      .where(eq(serverHealAttempts.id, attemptId))
      .limit(1);
    if (!row || row.status !== 'in_progress') {
      console.log(`[HealPoller] ${attemptId}: attempt no longer in_progress (${row?.status ?? 'missing'}); exiting`);
      return;
    }

    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        await finalize(attemptId, 'succeeded', undefined);
        console.log(`[HealPoller] ${attemptId}: workspace healthy; marked succeeded`);
        return;
      }
      lastError = `/health returned ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  await finalize(attemptId, 'failed', lastError ?? 'health poll timeout after 2 minutes');
  console.warn(`[HealPoller] ${attemptId}: timed out; marked failed (${lastError ?? 'no response'})`);
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
