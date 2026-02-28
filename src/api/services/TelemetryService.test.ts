import { describe, it, expect, vi, afterEach } from 'vitest';

import { trackGa4 } from './TelemetryService';

describe('TelemetryService.trackGa4', () => {
  const prevEnv = { ...process.env };
  const prevFetch = (globalThis as any).fetch;

  afterEach(() => {
	    // Restore env safely (avoid re-assigning process.env in some runtimes)
	    for (const k of Object.keys(process.env)) {
	      if (!(k in prevEnv)) delete (process.env as any)[k];
	    }
	    for (const [k, v] of Object.entries(prevEnv)) {
	      if (v === undefined) delete (process.env as any)[k];
	      else process.env[k] = v;
	    }
    (globalThis as any).fetch = prevFetch;
    vi.restoreAllMocks();
  });

  it('returns enabled:false when GA4_API_SECRET is not configured', async () => {
    delete (process.env as any).GA4_API_SECRET;

    const res = await trackGa4({
      clientId: 'client-123',
      userId: 'user-123',
      events: [{ name: 'test_event', params: { a: 'b' } }],
    });

    expect(res.enabled).toBe(false);
    expect(res.forwarded).toBe(false);
  });

  it('forwards to GA when configured (mocked fetch)', async () => {
    process.env.GA4_API_SECRET = 'test-secret';
    process.env.GA4_MEASUREMENT_ID = 'G-TEST123';
    delete (process.env as any).GA4_DEBUG;

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    (globalThis as any).fetch = fetchMock;

    const res = await trackGa4({
      clientId: 'client-123',
      userId: 'user-123',
      events: [{ name: 'test_event', params: { a: 'b', n: 1, ok: true, nope: { x: 1 } } }],
      context: { platform: 'electron', appVersion: '0.0.0-test' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.enabled).toBe(true);
    expect(res.forwarded).toBe(true);
    expect(res.status).toBe(204);
  });
});
