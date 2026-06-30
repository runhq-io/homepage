import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// A suspended workspace whose cold boot outruns the session handler's wake
// budget used to block the request long enough for the edge gateway (and the
// client's own ~60s fetch abort) to give up and return a raw 504 the client
// couldn't recover from. The handler now bounds how long it blocks and returns
// a fast, structured `503 { starting: true }` instead, while the wake finishes
// in the background. These tests pin that behavior.

const h = vi.hoisted(() => ({
  server: null as any,
  wake: vi.fn(),
}));

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(async () => 'user-1'),
}));
vi.mock('../db/index', () => ({
  db: {
    // Only the `select(...).from(users).where(...)` lookup for the session JWT
    // display fields runs before the wake branch under test.
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ username: 'u', name: 'U', email: 'u@example.com' }]),
      }),
    }),
  },
}));
vi.mock('./services/providers/registry', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, isAnyProviderConfigured: () => true };
});
vi.mock('./services/ServerService', () => ({
  gateServerAccess: vi.fn(async () => ({ ok: true })),
  getMemberRole: vi.fn(async () => 'owner'),
  getServer: vi.fn(async () => h.server),
  wakeRemoteServerInternal: (...args: unknown[]) => h.wake(...args),
  setServerStatus: vi.fn(async () => {}),
  reprovisionRemoteServer: vi.fn(async () => {}),
}));

import { createHttpApp } from './HttpServer';

function sessionRequest() {
  const app = createHttpApp();
  return app.request('/api/servers/srv1/session', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
  });
}

describe('POST /api/servers/:serverId/session — cold wake budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.wake.mockReset();
    // Remote machine that exists but is cold: status is a stale 'online' with an
    // old heartbeat, so the fast-path is skipped and the wake branch is taken.
    h.server = {
      id: 'srv1',
      name: 'Bluesky',
      deploymentType: 'remote',
      status: 'online',
      machineId: 'm1',
      flyAppName: 'app1',
      provider: 'fly',
      lastSeen: new Date(Date.now() - 5 * 60_000),
      migrationInProgress: false,
      sessionTokenExpirySeconds: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 503 { starting: true } when the wake exceeds the budget', async () => {
    // Wake never resolves within the request — the machine is still booting.
    h.wake.mockReturnValue(new Promise(() => {}));

    const resPromise = sessionRequest();
    // Drive past the 20s wake budget without real waiting.
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await resPromise;

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.starting).toBe(true);
    expect(body.serverName).toBe('Bluesky');
  });

  it('surfaces a genuine wake failure as a plain 503 (not masked as starting)', async () => {
    h.wake.mockResolvedValue({ success: false, error: 'Machine reported destroyed by provider.' });

    const resPromise = sessionRequest();
    await vi.advanceTimersByTimeAsync(0);
    const res = await resPromise;

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.starting).toBeUndefined();
    expect(body.error).toContain('destroyed');
  });
});
