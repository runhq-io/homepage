/**
 * Helpers for the widget's cookie-based authentication path
 * (RunHQ workspace-member auto-recognition).
 *
 * Spec: docs/superpowers/specs/2026-05-10-widget-runhq-member-detection-design.md
 *
 * The cookie itself (`rw_session`) is set at every console-login point and
 * cleared at logout. It carries the same signed session JWT as `auth_token`
 * but with cross-origin-friendly attributes (SameSite=None; Secure; HttpOnly;
 * scoped to /api/widget/) so it can flow into a credentialed widget API
 * request from the customer's site.
 *
 * Because cookie auth introduces CSRF risk that doesn't exist on the
 * existing token-bearer path, we issue a stateless double-submit CSRF
 * token on every authenticated /api/widget/identity response and require
 * it on every cookie-authenticated state-changing request.
 */
import * as jose from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RW_SESSION_COOKIE = 'rw_session';

let _jwtSecret: Uint8Array | null = null;

function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        '[rw_session] JWT_SECRET is not set. Required for cookie session verification.',
      );
    }
    _jwtSecret = new TextEncoder().encode(secret);
  }
  return _jwtSecret;
}

/**
 * Cookie attributes for `rw_session`.
 *
 * Production: SameSite=None + Secure so the browser ships it cross-origin
 * (a widget on acme.com calling console.runhq.io's API). Modern browsers
 * reject SameSite=None without Secure, so the two go together.
 *
 * Dev: SameSite=Lax + Secure=false. Cross-origin testing in dev is
 * inherently broken under SameSite=None+Secure (no HTTPS on localhost),
 * but the cookie still sets and same-port testing works. Same fallback
 * pattern as the existing `auth_token` cookie.
 *
 * Path: scoped to /api/widget/ so the cookie never flows to console
 * routes that don't need it (defense in depth — even an XSS that could
 * trigger a request to /api/some-other-route wouldn't carry rw_session).
 *
 * Domain: not set explicitly. The cookie is host-only, scoped to the API
 * origin (e.g. console.runhq.io). If/when the API is split onto a
 * separate subdomain (api.runhq.io) it will need a `.runhq.io` domain;
 * adding that is a config change, not code.
 *
 * MaxAge: 7 days. Shorter than auth_token (30 days) because rw_session
 * travels in third-party context to multiple embed origins; we want
 * faster auto-revocation if a session goes cold.
 */
export interface RwSessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'none' | 'lax';
  path: '/api/widget/';
  maxAge: number;
}

export function rwSessionCookieOptions(): RwSessionCookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/widget/',
    maxAge: 7 * 24 * 60 * 60,
  };
}

/**
 * Verifies a `rw_session` cookie value (a signed session JWT) and
 * returns both the userId and the JWT's `iat` (seconds since epoch),
 * which is needed to derive the per-session CSRF token.
 *
 * Returns null on bad signature, expiry, missing claims, or scoped
 * tokens (e.g. an MFA-pending JWT mistakenly cookie-set).
 */
export async function verifyRwSession(
  token: string,
): Promise<{ userId: string; iat: number } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
      algorithms: ['HS256'],
    });
    if (payload.scope) return null; // session tokens have no scope claim
    if (typeof payload.userId !== 'string') return null;
    if (typeof payload.iat !== 'number') return null;
    return { userId: payload.userId, iat: payload.iat };
  } catch {
    return null;
  }
}

/**
 * True when `cookieValue` is a currently-valid rw_session for `userId`.
 *
 * Used by the console's `/api/widget/user-token` bootstrap to decide whether to
 * REUSE the caller's existing session cookie rather than minting a fresh one.
 * Re-minting assigns a new JWT `iat`, and the widget's per-session CSRF token is
 * bound to that `iat` (see {@link csrfTokenFor}). Because the embedded widget
 * captures its CSRF token only once (its `init()` is idempotent), a re-mint
 * after capture silently invalidates every subsequent widget write. Reusing a
 * still-valid session keeps `iat` — and the CSRF token — stable for the
 * session's lifetime.
 */
export async function rwSessionMatchesUser(
  cookieValue: string | undefined | null,
  userId: string,
): Promise<boolean> {
  if (!cookieValue) return false;
  const verified = await verifyRwSession(cookieValue);
  return !!verified && verified.userId === userId;
}

/**
 * The CSRF secret used to derive per-session tokens. Falls back to the
 * JWT_SECRET-derived value if WIDGET_CSRF_SECRET is unset, so the system
 * boots without an extra env var (documented behavior). In production the
 * recommendation is to set WIDGET_CSRF_SECRET so the CSRF surface and
 * session signing surface use independent keys.
 */
function getCsrfSecret(): Buffer {
  const explicit = process.env.WIDGET_CSRF_SECRET;
  if (explicit && explicit.length > 0) return Buffer.from(explicit, 'utf8');
  const jwt = process.env.JWT_SECRET;
  if (!jwt) throw new Error('[CSRF] Neither WIDGET_CSRF_SECRET nor JWT_SECRET is set.');
  // Domain-separate by hashing with a fixed string so the same JWT_SECRET
  // can't accidentally double-serve as a session signer AND CSRF key.
  return Buffer.from(createHmac('sha256', jwt).update('rw_widget_csrf_v1').digest());
}

/**
 * Compute the CSRF token for a given (userId, session-iat) pair.
 *
 * Bound to iat so a renewed session implicitly renews the token; bound to
 * userId so a token issued for user A cannot be used by user B even if
 * they happened to log in at the same iat second.
 */
export function csrfTokenFor(userId: string, iat: number): string {
  const secret = getCsrfSecret();
  return createHmac('sha256', secret)
    .update(`${userId}:${iat}`)
    .digest('hex');
}

/** Constant-time CSRF token verification. */
export function verifyCsrfToken(
  presented: string | undefined | null,
  userId: string,
  iat: number,
): boolean {
  if (!presented || typeof presented !== 'string') return false;
  const expected = csrfTokenFor(userId, iat);
  // timingSafeEqual requires equal-length buffers.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(presented, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

/**
 * Normalize an embed origin to the canonical form we store in
 * widget_projects.allowed_origins. Returns null on malformed input.
 *
 * Rules:
 *   - Must parse via WHATWG URL.
 *   - Protocol must be http: or https:.
 *   - Host is lowercased.
 *   - Default port (80 for http, 443 for https) is stripped.
 *   - Path/query/fragment is dropped — origins only.
 *   - Trailing slashes removed.
 */
export function normalizeOrigin(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const isDefaultPort =
    (url.protocol === 'http:' && (url.port === '' || url.port === '80')) ||
    (url.protocol === 'https:' && (url.port === '' || url.port === '443'));
  const host = url.hostname.toLowerCase();
  const port = isDefaultPort ? '' : `:${url.port}`;
  return `${url.protocol}//${host}${port}`;
}
