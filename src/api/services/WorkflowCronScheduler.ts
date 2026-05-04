/**
 * WorkflowCronScheduler — background worker that fires due cron trigger nodes.
 *
 * On each tick the scheduler:
 *   1. Claims rows from workflow_cron_schedules WHERE enabled = true AND
 *      next_fire_at <= now, using FOR UPDATE SKIP LOCKED so concurrent
 *      scheduler instances don't double-fire.
 *   2. Advances next_fire_at for each claimed row inside the same transaction.
 *   3. POSTs to the target server's /api/internal/cron-fire endpoint with an
 *      HMAC-signed body outside the transaction (so the DB lock is released
 *      before the outbound HTTP call, which may be slow).
 *
 * Wire-up note: call `start()` during server boot and `stop()` during graceful
 * shutdown. Do NOT call `start()` multiple times — subsequent calls are no-ops.
 */

import { sql } from 'drizzle-orm';
import { parseExpression } from 'cron-parser';
import { signPayload } from '../../lib/hmac.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface ServerRegistry {
  getServerUrl(serverId: string): Promise<string | null>;
  getServerToken(serverId: string): Promise<string | null>;
}

export interface SchedulerMetrics {
  dispatched(delta: number): void;
  failed(delta: number): void;
}

export interface SchedulerConfig {
  db: Database;
  serverRegistry: ServerRegistry;
  metrics?: SchedulerMetrics;
  /** Override fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Tick interval in ms; default 60_000. */
  tickIntervalMs?: number;
  /** Max rows to claim per tick; default 100. */
  batchSize?: number;
}

interface ClaimedRow {
  id: string;
  serverId: string;
  agentId: string;
  triggerNodeId: string;
  schedule: string;
  timezone: string | null;
}

export class WorkflowCronScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly fetchImpl: typeof fetch;
  private readonly tickIntervalMs: number;
  private readonly batchSize: number;

  constructor(private readonly cfg: SchedulerConfig) {
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.tickIntervalMs = cfg.tickIntervalMs ?? 60_000;
    this.batchSize = cfg.batchSize ?? 100;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        console.error('[WorkflowCronScheduler] tick failed:', err),
      );
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Public for tests. Safe to call concurrently — SKIP LOCKED prevents
   * double-firing when multiple scheduler instances run simultaneously.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const due = await this.claimDueRows(now);

    for (const row of due) {
      try {
        await this.dispatch(row, now);
        this.cfg.metrics?.dispatched(1);
      } catch (err) {
        console.error(`[WorkflowCronScheduler] dispatch ${row.id} failed:`, err);
        this.cfg.metrics?.failed(1);
      }
    }
  }

  private async claimDueRows(now: Date): Promise<ClaimedRow[]> {
    return this.cfg.db.transaction(async (tx: any) => {
      const result = await tx.execute(sql`
        SELECT id, server_id, agent_id, trigger_node_id, schedule, timezone
          FROM workflow_cron_schedules
         WHERE enabled = true AND next_fire_at <= ${now}
         ORDER BY next_fire_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${this.batchSize}
      `);

      // Drizzle wraps raw results differently across drivers: Neon returns the
      // array directly; node-postgres returns { rows: [...] }.
      const rows: any[] = (result as { rows?: any[] }).rows ?? (result as any[]);

      const claimed: ClaimedRow[] = [];

      for (const r of rows) {
        let next: Date;
        try {
          next = parseExpression(r.schedule, {
            tz: r.timezone ?? undefined,
            currentDate: now,
          }).next().toDate();
        } catch (err) {
          // Malformed schedule: disable it so it doesn't block the queue.
          // The row is NOT added to `claimed` — it won't be dispatched.
          console.error(
            `[WorkflowCronScheduler] disabling malformed schedule ${r.id}:`,
            err,
          );
          await tx.execute(sql`
            UPDATE workflow_cron_schedules
               SET enabled = false, last_fired_at = ${now}
             WHERE id = ${r.id}
          `);
          continue;
        }

        await tx.execute(sql`
          UPDATE workflow_cron_schedules
             SET last_fired_at = ${now}, next_fire_at = ${next}
           WHERE id = ${r.id}
        `);

        claimed.push({
          id: r.id,
          serverId: r.server_id,
          agentId: r.agent_id,
          triggerNodeId: r.trigger_node_id,
          schedule: r.schedule,
          timezone: r.timezone as string | null,
        });
      }

      return claimed;
    });
  }

  private async dispatch(row: ClaimedRow, fireTime: Date): Promise<void> {
    const url = await this.cfg.serverRegistry.getServerUrl(row.serverId);
    const token = await this.cfg.serverRegistry.getServerToken(row.serverId);

    if (!url || !token) {
      throw new Error(`no url/token for server ${row.serverId}`);
    }

    const ts = new Date().toISOString();
    const body = JSON.stringify({
      agentId: row.agentId,
      triggerNodeId: row.triggerNodeId,
      fireTime: fireTime.toISOString(),
    });
    const sig = signPayload(token, ts, body);

    const res = await this.fetchImpl(`${url}/api/internal/cron-fire`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runhq-timestamp': ts,
        'x-runhq-signature': sig,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`cron-fire responded ${res.status}: ${text}`);
    }
  }
}
