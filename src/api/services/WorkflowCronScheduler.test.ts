import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowCronScheduler, type SchedulerConfig, type ServerRegistry } from './WorkflowCronScheduler.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_URL = 'https://ws-1.example.com';
const SERVER_TOKEN = 'secret-token';

function makeRow(overrides?: Partial<{
  id: string; server_id: string; agent_id: string; trigger_node_id: string;
  schedule: string; timezone: string | null;
}>) {
  return {
    id: 'wcron_ws1_agentA_node1',
    server_id: 'ws_1',
    agent_id: 'agent_A',
    trigger_node_id: 'node_1',
    schedule: '*/5 * * * *',
    timezone: null,
    ...overrides,
  };
}

/** Build a mock db whose transaction yields the given rows from the SELECT. */
function makeMockDb(rows: any[] = []): { db: any; executeCallArgs: any[] } {
  const executeCallArgs: any[] = [];

  const mockTx = {
    execute: vi.fn().mockImplementation(async (query: any) => {
      executeCallArgs.push(query);
      // Return the rows for the SELECT call (first execute per tick); subsequent
      // UPDATE calls return undefined and are ignored.
      return rows;
    }),
  };

  const db = {
    transaction: vi.fn().mockImplementation(
      async (fn: (tx: any) => Promise<any>) => fn(mockTx),
    ),
    _mockTx: mockTx,
  };

  return { db: db as any, executeCallArgs };
}

function makeRegistry(overrides?: Partial<ServerRegistry>): ServerRegistry {
  return {
    getServerUrl: vi.fn().mockResolvedValue(SERVER_URL),
    getServerToken: vi.fn().mockResolvedValue(SERVER_TOKEN),
    ...overrides,
  };
}

function makeFetchOk(): typeof fetch {
  return vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as any;
}

function makeConfig(overrides?: Partial<SchedulerConfig>): SchedulerConfig {
  return {
    db: makeMockDb([]).db,
    serverRegistry: makeRegistry(),
    fetchImpl: makeFetchOk(),
    tickIntervalMs: 60_000,
    batchSize: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowCronScheduler', () => {
  describe('tick() — happy path', () => {
    it('calls dispatch once per due row', async () => {
      const rows = [makeRow()];
      const { db } = makeMockDb(rows);
      const fetchImpl = makeFetchOk();
      const cfg = makeConfig({ db, fetchImpl });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('dispatches to the correct URL path', async () => {
      const rows = [makeRow()];
      const { db } = makeMockDb(rows);
      const fetchImpl = makeFetchOk();
      const cfg = makeConfig({ db, fetchImpl });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      const [calledUrl] = (fetchImpl as any).mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe(`${SERVER_URL}/api/internal/cron-fire`);
    });

    it('sends the correct agentId and triggerNodeId in the body', async () => {
      const row = makeRow({ agent_id: 'agent_Z', trigger_node_id: 'node_X' });
      const { db } = makeMockDb([row]);
      const fetchImpl = makeFetchOk();
      const cfg = makeConfig({ db, fetchImpl });
      const sched = new WorkflowCronScheduler(cfg);

      const fireTime = new Date('2026-05-04T12:00:00.000Z');
      await sched.tick(fireTime);

      const [, init] = (fetchImpl as any).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.agentId).toBe('agent_Z');
      expect(body.triggerNodeId).toBe('node_X');
      expect(body.fireTime).toBe(fireTime.toISOString());
    });

    it('sends HMAC headers (x-runhq-timestamp and x-runhq-signature)', async () => {
      const rows = [makeRow()];
      const { db } = makeMockDb(rows);
      const fetchImpl = makeFetchOk();
      const cfg = makeConfig({ db, fetchImpl });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      const [, init] = (fetchImpl as any).mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['x-runhq-timestamp']).toBeTruthy();
      expect(headers['x-runhq-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('increments metrics.dispatched on success', async () => {
      const rows = [makeRow(), makeRow({ id: 'wcron_ws1_agentA_node2', trigger_node_id: 'node_2' })];
      const { db } = makeMockDb(rows);
      const metrics = { dispatched: vi.fn(), failed: vi.fn() };
      const cfg = makeConfig({ db, metrics });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(metrics.dispatched).toHaveBeenCalledTimes(2);
      expect(metrics.failed).not.toHaveBeenCalled();
    });

    it('does nothing when there are no due rows', async () => {
      const { db } = makeMockDb([]);
      const fetchImpl = makeFetchOk();
      const cfg = makeConfig({ db, fetchImpl });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('tick() — malformed schedule path', () => {
    it('disables a row with an unparseable schedule and skips dispatch', async () => {
      const rows = [makeRow({ schedule: 'not-a-cron' })];
      const { db, executeCallArgs } = makeMockDb(rows);
      const fetchImpl = makeFetchOk();
      const metrics = { dispatched: vi.fn(), failed: vi.fn() };
      const cfg = makeConfig({ db, fetchImpl, metrics });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      // Should not dispatch the malformed row.
      expect(fetchImpl).not.toHaveBeenCalled();
      // Should not count it as dispatched or failed via metrics.
      expect(metrics.dispatched).not.toHaveBeenCalled();
      expect(metrics.failed).not.toHaveBeenCalled();

      // The UPDATE that disables the row should have been executed.
      // Drizzle's sql`` objects store text in queryChunks[n].value arrays.
      const updateCall = executeCallArgs.find((q: any) => {
        const chunks: any[] = q?.queryChunks ?? [];
        return chunks.some((chunk: any) =>
          Array.isArray(chunk?.value) &&
          chunk.value.some((v: any) => typeof v === 'string' && v.includes('enabled = false')),
        );
      });
      expect(updateCall).toBeDefined();
    });
  });

  describe('tick() — dispatch failure path', () => {
    it('increments metrics.failed when fetch returns a non-ok response', async () => {
      const rows = [makeRow()];
      const { db } = makeMockDb(rows);
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('server error', { status: 500 }),
      ) as any;
      const metrics = { dispatched: vi.fn(), failed: vi.fn() };
      const cfg = makeConfig({ db, fetchImpl, metrics });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(metrics.failed).toHaveBeenCalledTimes(1);
      expect(metrics.dispatched).not.toHaveBeenCalled();
    });

    it('increments metrics.failed when server registry has no url', async () => {
      const rows = [makeRow()];
      const { db } = makeMockDb(rows);
      const metrics = { dispatched: vi.fn(), failed: vi.fn() };
      const registry = makeRegistry({ getServerUrl: vi.fn().mockResolvedValue(null) });
      const cfg = makeConfig({ db, serverRegistry: registry, metrics });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(metrics.failed).toHaveBeenCalledTimes(1);
    });

    it('continues processing other rows when one dispatch fails', async () => {
      const rows = [
        makeRow({ id: 'wcron_ws1_agentA_node1', trigger_node_id: 'node_1' }),
        makeRow({ id: 'wcron_ws1_agentA_node2', trigger_node_id: 'node_2' }),
      ];
      const { db } = makeMockDb(rows);
      let callCount = 0;
      const fetchImpl = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Response(callCount === 1 ? 'err' : '{}', {
          status: callCount === 1 ? 500 : 200,
        });
      }) as any;
      const metrics = { dispatched: vi.fn(), failed: vi.fn() };
      const cfg = makeConfig({ db, fetchImpl, metrics });
      const sched = new WorkflowCronScheduler(cfg);

      await sched.tick(new Date());

      expect(metrics.failed).toHaveBeenCalledTimes(1);
      expect(metrics.dispatched).toHaveBeenCalledTimes(1);
    });
  });

  describe('start() / stop()', () => {
    it('start() is idempotent — calling twice only creates one interval', () => {
      const cfg = makeConfig();
      const sched = new WorkflowCronScheduler(cfg);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      sched.start();
      sched.start(); // second call should be a no-op

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      sched.stop();
      setIntervalSpy.mockRestore();
    });

    it('stop() clears the interval', () => {
      const cfg = makeConfig();
      const sched = new WorkflowCronScheduler(cfg);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      sched.start();
      sched.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      clearIntervalSpy.mockRestore();
    });
  });
});
