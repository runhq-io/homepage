import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { extractUserIdFromToken, createToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';

/**
 * Two-step admin-console bridge.
 *
 * The previous implementation passed a 30-day session JWT in the URL query
 * string. URLs are persisted in browser history, Referer headers, CDN access
 * logs, and Fly request logs — anyone who can read those captured a long-lived
 * admin session token.
 *
 * Replacement flow:
 *   1. Client POSTs `/api/auth/admin-bridge` with `Authorization: Bearer <jwt>`.
 *      Server validates the JWT, confirms admin, and returns a one-time
 *      `code` (32 random bytes hex, ~30s TTL, single-use).
 *   2. Client navigates to `GET /api/auth/admin-bridge?code=<code>`.
 *      Server consumes the code, mints a fresh session JWT, sets it as an
 *      HttpOnly cookie on the console origin, and redirects to /admin.
 *
 * Even if the redirect URL leaks via logs/referrer, the embedded code is
 * single-use and expired within 30 seconds.
 */

interface ExchangeCode {
  userId: string;
  expiresAt: number;
}

const EXCHANGE_TTL_MS = 30 * 1000;
const exchangeCodes = new Map<string, ExchangeCode>();

// Best-effort cleanup. Map entries also expire on lookup, so this just bounds
// memory growth from unconsumed codes.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, data] of exchangeCodes) {
    if (data.expiresAt <= now) exchangeCodes.delete(code);
  }
}, 60_000);
cleanupTimer.unref?.();

function corsHeadersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
  if (!origin) return headers;
  const isAllowed = origin.endsWith('.runhq.io') ||
    origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
  if (isAllowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** Step 1: caller exchanges its bearer JWT for a one-time code. */
export async function POST(request: NextRequest) {
  const headers = corsHeadersFor(request.headers.get('origin'));

  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Bearer token required' }, { status: 401, headers });
  }
  const userId = await extractUserIdFromToken(auth.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers });
  }
  if (!(await isAdmin(userId))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers });
  }

  const code = randomBytes(32).toString('hex');
  exchangeCodes.set(code, { userId, expiresAt: Date.now() + EXCHANGE_TTL_MS });
  return NextResponse.json({ code, expiresInSeconds: EXCHANGE_TTL_MS / 1000 }, { headers });
}

/** Step 2: caller navigates here with the code; we set the cookie and redirect. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Code required' }, { status: 400 });
  }
  const entry = exchangeCodes.get(code);
  // Single-use: delete on first lookup whether or not it was valid.
  exchangeCodes.delete(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 });
  }

  // Re-confirm admin status at redemption time — the underlying user may have
  // been demoted between exchange and redemption.
  if (!(await isAdmin(entry.userId))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const freshToken = await createToken(entry.userId);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const baseUrl = host ? `${proto}://${host}` : request.url;
  const response = NextResponse.redirect(new URL('/admin', baseUrl));
  response.cookies.set('auth_token', freshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return response;
}

export async function OPTIONS(request: NextRequest) {
  const headers = corsHeadersFor(request.headers.get('origin'));
  return new NextResponse(null, { status: 204, headers });
}
