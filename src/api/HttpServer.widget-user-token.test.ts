import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as jose from 'jose';

// Drives the console feedback-widget bootstrap endpoint `/api/widget/user-token`.
//
// Regression: the endpoint minted a fresh `rw_session` cookie (new JWT `iat`)
// on EVERY call. The console calls it on every load and whenever the auth token
// rotates, but the widget's `init()` is idempotent and captures its per-session
// CSRF token (which is bound to the session `iat`) exactly once. A re-mint after
// that capture silently desyncs the cookie's `iat` from the widget's CSRF token,
// so every subsequent widget write (assign agent, open Live session, …) fails
// the cookie-path CSRF check and returns 401.
//
// Contract: a call that already carries a valid rw_session for the same user
// must REUSE it (no rotation), keeping `iat` — and therefore the widget's CSRF
// token — stable for the session's lifetime.

vi.mock('./oauth/index', () => ({ default: new Hono() }));
vi.mock('./auth/jwt', () => ({
  createToken: vi.fn(),
  verifyToken: vi.fn(),
  extractUserIdFromToken: vi.fn(),
}));
vi.mock('./services/ServerService', () => ({
  checkCloudOpPermission: vi.fn(),
  getServer: vi.fn(),
  fetchFromServer: vi.fn(),
  serverTokenFetch: vi.fn(),
}));
vi.mock('./services/WidgetService', () => ({
  isOriginAllowlisted: vi.fn(async () => false),
  authenticateWidget: vi.fn(async () => null),
  listPublicProjects: vi.fn(),
  generateUserTokenBySecret: vi.fn(async () => ({ token: 'widget-jwt', slug: 'feedback-slug' })),
  WidgetError: class WidgetError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'WidgetError';
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock('./services/WidgetRateLimiter', () => ({
  widgetRateLimiter: { check: vi.fn(), checkDefault: vi.fn() },
}));
vi.mock('./services/TaskAttachmentStorageService', () => ({
  TaskAttachmentStorageService: class { isConfigured() { return false; } },
}));

import { createHttpApp } from './HttpServer';
import { createToken, extractUserIdFromToken } from './auth/jwt';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const USER_ID = '00000000-0009-4000-a000-000000000001';

/** Sign a real rw_session JWT (what the browser would already hold). */
async function makeRwSession(userId: string): Promise<string> {
  return new jose.SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function rwSessionInSetCookie(res: Response): boolean {
  const header = res.headers.get('set-cookie');
  return !!header && header.includes('rw_session=');
}

describe('GET /api/widget/user-token — rw_session cookie minting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FEEDBACK_WIDGET_SECRET = 'feedback-secret';
    (extractUserIdFromToken as any).mockResolvedValue(USER_ID);
    (createToken as any).mockResolvedValue('newly-minted-session');
  });

  it('mints an rw_session cookie when the caller has none', async () => {
    const app = createHttpApp();
    const res = await app.request('/api/widget/user-token', {
      headers: { Authorization: 'Bearer bearer-token' },
    });
    expect(res.status).toBe(200);
    expect(rwSessionInSetCookie(res)).toBe(true);
  });

  it('does NOT rotate the session when a valid rw_session is already presented', async () => {
    const app = createHttpApp();
    const existing = await makeRwSession(USER_ID);
    const res = await app.request('/api/widget/user-token', {
      headers: {
        Authorization: 'Bearer bearer-token',
        Cookie: `rw_session=${existing}`,
      },
    });
    expect(res.status).toBe(200);
    // Re-minting here would assign a new `iat`, invalidating the CSRF token the
    // already-initialized widget captured — the root cause of the 401 on writes.
    expect(rwSessionInSetCookie(res)).toBe(false);
    expect(createToken as any).not.toHaveBeenCalled();
  });

  it('re-mints when the presented rw_session is invalid (bad signature)', async () => {
    const app = createHttpApp();
    const res = await app.request('/api/widget/user-token', {
      headers: {
        Authorization: 'Bearer bearer-token',
        Cookie: 'rw_session=not-a-valid-jwt',
      },
    });
    expect(res.status).toBe(200);
    expect(rwSessionInSetCookie(res)).toBe(true);
  });

  it('re-mints when the presented rw_session belongs to a different user', async () => {
    const app = createHttpApp();
    const otherSession = await makeRwSession('00000000-0009-4000-a000-000000000002');
    const res = await app.request('/api/widget/user-token', {
      headers: {
        Authorization: 'Bearer bearer-token',
        Cookie: `rw_session=${otherSession}`,
      },
    });
    expect(res.status).toBe(200);
    expect(rwSessionInSetCookie(res)).toBe(true);
  });
});
