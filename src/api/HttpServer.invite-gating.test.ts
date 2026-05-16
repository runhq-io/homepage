import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('../lib/signupGating', () => ({
  isSignupInviteRequired: vi.fn(),
  assertActivated: vi.fn(),
}));
vi.mock('./services/SettingsService', () => ({
  getSettings: vi.fn(async () => ({ serverCreationDisabled: false })),
}));

import { createHttpApp } from './HttpServer';
import * as jwt from './auth/jwt';
import * as signupGating from '../lib/signupGating';
import { getSettings } from './services/SettingsService';

describe('POST /api/servers invite gating', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks wipes factory implementations — re-establish the ones the
    // handler reaches before the gate.
    (getSettings as any).mockResolvedValue({ serverCreationDisabled: false });
    (jwt.extractUserIdFromToken as any).mockResolvedValue('user-unactivated');
  });

  it('returns 403 activation_required when gated and user not activated', async () => {
    (signupGating.assertActivated as any).mockResolvedValue(false);
    const app = createHttpApp();
    const res = await app.request('/api/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-server' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'activation_required' });
    expect(signupGating.assertActivated).toHaveBeenCalledWith('user-unactivated');
  });

  it('passes the gate (does not 403) when assertActivated resolves true', async () => {
    (signupGating.assertActivated as any).mockResolvedValue(true);
    const app = createHttpApp();
    const res = await app.request('/api/servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my-server' }),
    });
    expect(res.status).not.toBe(403);
  });
});
