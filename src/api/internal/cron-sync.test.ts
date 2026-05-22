import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { signPayload, REPLAY_WINDOW_MS } from '../../lib/hmac.js';
import { registerCronSyncRoute, type CronSyncDeps } from './cron-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_ID = 'ws_test_server';
const AGENT_ID = 'agent_abc';
const SECRET = 'shared-secret-value';

function makeDeps(overrides?: Partial<CronSyncDeps>): CronSyncDeps {
  const mockTx = {
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const mockDb = {
    transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(mockTx)),
    _mockTx: mockTx,
  };

  return {
    db: mockDb as any,
    getServerToken: vi.fn().mockResolvedValue(SECRET),
    ...overrides,
  };
}

function makeApp(deps: CronSyncDeps): Hono {
  const app = new Hono();
  registerCronSyncRoute(app, deps);
  return app;
}

function freshTimestamp(): string {
  return new Date().toISOString();
}

async function postCronSync(
  app: Hono,
  payload: unknown,
  opts?: { ts?: string; sig?: string; secret?: string },
): Promise<Response> {
  const body = JSON.stringify(payload);
  const ts = opts?.ts ?? freshTimestamp();
  const secret = opts?.secret ?? SECRET;
  const sig = opts?.sig ?? signPayload(secret, ts, body);

  return app.request('http://localhost/api/internal/cron-sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-runhq-timestamp': ts,
      'x-runhq-signature': sig,
    },
    body,
  });
}

const VALID_PAYLOAD = {
  serverId: SERVER_ID,
  owner: { kind: 'agent', agentId: AGENT_ID },
  workflowVersion: 1,
  schedules: [
    { triggerNodeId: 'node_1', schedule: '*/5 * * * *' },
    { triggerNodeId: 'node_2', schedule: '0 9 * * 1-5', timezone: 'America/New_York' },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/internal/cron-sync', () => {
  let deps: CronSyncDeps & { _mockTx: any };

  beforeEach(() => {
    deps = makeDeps() as any;
  });

  describe('happy path', () => {
    it('returns 200 with ok:true and correct count', async () => {
      const app = makeApp(deps);
      const res = await postCronSync(app, VALID_PAYLOAD);
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.count).toBe(2);
    });

    it('calls db.transaction once per request', async () => {
      const app = makeApp(deps);
      await postCronSync(app, VALID_PAYLOAD);
      expect((deps.db as any).transaction).toHaveBeenCalledTimes(1);
    });

    it('deletes existing rows for the (serverId, agentId) pair', async () => {
      const app = makeApp(deps);
      await postCronSync(app, VALID_PAYLOAD);
      const tx = (deps.db as any)._mockTx;
      expect(tx.delete).toHaveBeenCalledTimes(1);
    });

    it('inserts one row per schedule', async () => {
      const app = makeApp(deps);
      await postCronSync(app, VALID_PAYLOAD);
      const tx = (deps.db as any)._mockTx;
      expect(tx.insert).toHaveBeenCalledTimes(2);
    });

    it('inserts deterministic IDs in wcron_<server>_<agent>_<node> format', async () => {
      const capturedValues: any[] = [];
      const mockTx = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((v: any) => {
            capturedValues.push(v);
            return Promise.resolve(undefined);
          }),
        }),
      };
      const customDeps = makeDeps();
      (customDeps.db as any).transaction = vi.fn().mockImplementation(
        async (fn: (tx: any) => Promise<any>) => fn(mockTx),
      );
      const app = makeApp(customDeps);
      await postCronSync(app, VALID_PAYLOAD);

      expect(capturedValues[0].id).toBe(`wcron_${SERVER_ID}_agent_${AGENT_ID}_node_1`);
      expect(capturedValues[1].id).toBe(`wcron_${SERVER_ID}_agent_${AGENT_ID}_node_2`);
    });

    it('accepts a payload with zero schedules (clears all)', async () => {
      const app = makeApp(deps);
      const res = await postCronSync(app, { ...VALID_PAYLOAD, schedules: [] });
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.count).toBe(0);
    });
  });

  describe('HMAC / auth rejection', () => {
    it('returns 401 when x-runhq-timestamp header is missing', async () => {
      const app = makeApp(deps);
      const body = JSON.stringify(VALID_PAYLOAD);
      const res = await app.request('http://localhost/api/internal/cron-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runhq-signature': signPayload(SECRET, freshTimestamp(), body),
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when x-runhq-signature header is missing', async () => {
      const app = makeApp(deps);
      const body = JSON.stringify(VALID_PAYLOAD);
      const ts = freshTimestamp();
      const res = await app.request('http://localhost/api/internal/cron-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runhq-timestamp': ts,
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the timestamp is outside the replay window', async () => {
      const app = makeApp(deps);
      const expiredTs = new Date(Date.now() - REPLAY_WINDOW_MS - 5000).toISOString();
      const body = JSON.stringify(VALID_PAYLOAD);
      const res = await app.request('http://localhost/api/internal/cron-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runhq-timestamp': expiredTs,
          'x-runhq-signature': signPayload(SECRET, expiredTs, body),
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when the serverId is unknown (getServerToken returns null)', async () => {
      const unknownDeps = makeDeps({ getServerToken: vi.fn().mockResolvedValue(null) });
      const app = makeApp(unknownDeps);
      const res = await postCronSync(app, VALID_PAYLOAD);
      expect(res.status).toBe(403);
    });

    it('returns 401 when the HMAC signature is wrong (wrong secret)', async () => {
      const app = makeApp(deps);
      const res = await postCronSync(app, VALID_PAYLOAD, { secret: 'wrong-secret' });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the signature is tampered', async () => {
      const app = makeApp(deps);
      const res = await postCronSync(app, VALID_PAYLOAD, { sig: 'sha256=deadbeefdeadbeef' });
      expect(res.status).toBe(401);
    });
  });

  describe('payload validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const app = makeApp(deps);
      const ts = freshTimestamp();
      const raw = 'not-json';
      const sig = signPayload(SECRET, ts, raw);
      const res = await app.request('http://localhost/api/internal/cron-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runhq-timestamp': ts,
          'x-runhq-signature': sig,
        },
        body: raw,
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when serverId is missing', async () => {
      const app = makeApp(deps);
      const { serverId: _, ...noServer } = VALID_PAYLOAD;
      const res = await postCronSync(app, noServer);
      expect(res.status).toBe(400);
    });

    it('returns 400 when an invalid cron expression is supplied', async () => {
      const app = makeApp(deps);
      const bad = {
        ...VALID_PAYLOAD,
        schedules: [{ triggerNodeId: 'node_x', schedule: 'not-a-cron' }],
      };
      const res = await postCronSync(app, bad);
      expect(res.status).toBe(400);
    });
  });
});
