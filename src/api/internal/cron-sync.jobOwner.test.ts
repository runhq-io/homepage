import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { workflowCronSchedules } from '../../db/schema.js';
import { registerCronSyncRoute } from './cron-sync.js';
import { signPayload } from '../../lib/hmac.js';

const TOKEN = 'test-token-job-owner';
const SERVER_ID = 'ws_test_job_owner';

const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/runhq' });
const db = drizzle(pool, { schema });

async function send(app: Hono, body: object) {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  const sig = signPayload(TOKEN, ts, raw);
  return app.request('/api/internal/cron-sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runhq-timestamp': ts,
      'x-runhq-signature': sig,
    },
    body: raw,
  });
}

describe('cron-sync: job-owner', () => {
  let app: Hono;
  beforeEach(async () => {
    app = new Hono();
    registerCronSyncRoute(app, { db, getServerToken: async () => TOKEN });
    await db.delete(workflowCronSchedules).where(eq(workflowCronSchedules.serverId, SERVER_ID));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('stores a job-scoped schedule with agentId=NULL and jobId set', async () => {
    const res = await send(app, {
      serverId: SERVER_ID,
      owner: { kind: 'job', jobId: 'job_test_1' },
      workflowVersion: 1,
      schedules: [{ triggerNodeId: 't1', schedule: '* * * * *' }],
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(workflowCronSchedules)
      .where(eq(workflowCronSchedules.serverId, SERVER_ID));
    expect(rows.length).toBe(1);
    expect(rows[0].agentId).toBeNull();
    expect(rows[0].jobId).toBe('job_test_1');
    expect(rows[0].triggerNodeId).toBe('t1');
  });

  it('rejects payload missing owner discriminator', async () => {
    const res = await send(app, {
      serverId: SERVER_ID,
      workflowVersion: 1,
      schedules: [{ triggerNodeId: 't1', schedule: '* * * * *' }],
    });
    expect(res.status).toBe(400);
  });
});
