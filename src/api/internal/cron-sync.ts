import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
// cron-parser@4 is CJS-only; Node ESM's cjs-module-lexer doesn't always
// detect `parseExpression` as a named export, so we default-import the
// module object and destructure. Same pattern in WorkflowCronScheduler.ts.
import cronParser from 'cron-parser';
const { parseExpression } = cronParser;
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import { workflowCronSchedules } from '../../db/schema.js';
import { verifySignature, isWithinReplayWindow } from '../../lib/hmac.js';

export type Database = NodePgDatabase<typeof schema>;

const scheduleItemSchema = z.object({
  triggerNodeId: z.string().min(1),
  schedule: z.string().min(1).max(120),
  timezone: z.string().optional(),
});

const payloadSchema = z.object({
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  workflowVersion: z.number().int().nonnegative(),
  schedules: z.array(scheduleItemSchema),
});

export interface CronSyncDeps {
  db: Database;
  /** Per-server token lookup. Receives the serverId; returns the shared HMAC secret. */
  getServerToken(serverId: string): Promise<string | null>;
}

export function registerCronSyncRoute(app: Hono, deps: CronSyncDeps): void {
  app.post('/api/internal/cron-sync', async (c) => {
    const ts = c.req.header('x-runhq-timestamp');
    const sig = c.req.header('x-runhq-signature');
    if (!ts || !sig) throw new HTTPException(401, { message: 'missing signature headers' });
    if (!isWithinReplayWindow(ts)) throw new HTTPException(401, { message: 'timestamp out of window' });

    const raw = await c.req.text();

    let jsonBody: unknown;
    try {
      jsonBody = JSON.parse(raw);
    } catch {
      throw new HTTPException(400, { message: 'invalid JSON body' });
    }

    const parsed = payloadSchema.safeParse(jsonBody);
    if (!parsed.success) {
      throw new HTTPException(400, { message: parsed.error.message });
    }
    const body = parsed.data;

    const serverToken = await deps.getServerToken(body.serverId);
    if (!serverToken) throw new HTTPException(403, { message: 'unknown server' });
    if (!verifySignature(serverToken, ts, raw, sig)) {
      throw new HTTPException(401, { message: 'invalid signature' });
    }

    // Validate all cron expressions before touching the DB.
    const nextFireAtMap: Map<string, Date> = new Map();
    for (const s of body.schedules) {
      try {
        const it = parseExpression(s.schedule, {
          tz: s.timezone,
          currentDate: new Date(),
        });
        nextFireAtMap.set(s.triggerNodeId, it.next().toDate());
      } catch (err) {
        throw new HTTPException(400, {
          message: `invalid cron "${s.schedule}": ${(err as Error).message}`,
        });
      }
    }

    // Atomically replace all schedules for this (serverId, agentId).
    await deps.db.transaction(async (tx: any) => {
      await tx
        .delete(workflowCronSchedules)
        .where(
          and(
            eq(workflowCronSchedules.serverId, body.serverId),
            eq(workflowCronSchedules.agentId, body.agentId),
          ),
        );

      for (const s of body.schedules) {
        const nextFireAt = nextFireAtMap.get(s.triggerNodeId)!;
        await tx.insert(workflowCronSchedules).values({
          id: `wcron_${body.serverId}_${body.agentId}_${s.triggerNodeId}`,
          serverId: body.serverId,
          agentId: body.agentId,
          workflowVersion: body.workflowVersion,
          triggerNodeId: s.triggerNodeId,
          schedule: s.schedule,
          timezone: s.timezone ?? null,
          nextFireAt,
          enabled: true,
        });
      }
    });

    return c.json({ ok: true, count: body.schedules.length });
  });
}
