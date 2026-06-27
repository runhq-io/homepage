/**
 * Shared JWT token signing/verification.
 *
 * Scopes:
 *   - (no scope)      = session token (30 days)
 *   - 'mfa-pending'   = issued after password check when MFA is enabled;
 *                       only valid for POST /api/auth/mfa/verify
 *   - 'mfa-setup'     = carries an unpersisted TOTP secret through the
 *                       setup flow (10 min)
 */
import * as jose from 'jose';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb, oauthTokens } from '@/db';
import { hashToken } from '@/lib/oauth';

let _jwtSecret: Uint8Array | null = null;

function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        '[JWT] CRITICAL: JWT_SECRET is not set. Set it in your environment (see .env.example for local dev).',
      );
    }
    _jwtSecret = new TextEncoder().encode(secret);
  }
  return _jwtSecret;
}

const JWT_VERIFY_OPTIONS: jose.JWTVerifyOptions = { algorithms: ['HS256'] };

/** Session token — no scope claim. */
export async function createToken(userId: string): Promise<string> {
  return await new jose.SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getJwtSecret());
}

/** Verify a session token. Rejects scoped tokens. */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope) return null;
    if (typeof payload.userId === 'string') return payload.userId;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Bearer token to a userId, accepting either token format:
 *
 *   1. **JWT session token** — created by `createToken()`, used by the web
 *      client (cookie or Authorization header) and the desktop app. Verified
 *      cryptographically against `JWT_SECRET`. No DB hit.
 *
 *   2. **Opaque OAuth access token** — created by `/oauth/token` after the
 *      authorization-code + PKCE exchange completes; used by the mobile
 *      app (and any future first-party OAuth client). Stored hashed in the
 *      `oauth_tokens` table. Verified by hashing the bearer and looking
 *      up an unrevoked, unexpired row of type 'access'.
 *
 * This helper is the single bridge between the two formats. Every API route
 * that resolves a Bearer to a userId calls it (web-me, profile, mfa/*,
 * passkeys/*, etc.), so any of them automatically work for OAuth-authenticated
 * mobile clients too. `verifyToken` stays JWT-only and is used where the caller
 * knows it has a cookie (middleware, WebSocket auth, /oauth/authorize).
 *
 * **Scope check note**: this returns a userId without consulting the token's
 * OAuth scope. That's safe today because `/oauth/authorize` only mints codes
 * for clients in `FIRST_PARTY_CLIENT_IDS` (see `lib/oauth.ts::isFirstPartyClient`),
 * which are trusted to act on the user's behalf without per-endpoint scope
 * gating. If third-party OAuth clients are ever enabled, per-endpoint scope
 * checks must be added here or at the call sites.
 */
export async function extractUserIdFromToken(token: string): Promise<string | null> {
  // JWT first — cryptographic verify, no DB roundtrip.
  const jwtUserId = await verifyToken(token);
  if (jwtUserId) return jwtUserId;

  // Fall through to OAuth access token lookup.
  try {
    const db = getDb();
    const [row] = await db
      .select({ userId: oauthTokens.userId, expiresAt: oauthTokens.expiresAt })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, hashToken(token)),
          eq(oauthTokens.type, 'access'),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.expiresAt <= new Date()) return null;
    return row.userId;
  } catch {
    // DB unreachable or schema mismatch — fail closed.
    return null;
  }
}

export interface MfaPendingClaims {
  userId: string;
}

/** MFA-pending token: short-lived, scope='mfa-pending'. */
export async function createMfaPendingToken(userId: string): Promise<string> {
  return new jose.SignJWT({ userId, scope: 'mfa-pending' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(getJwtSecret());
}

export async function verifyMfaPendingToken(token: string): Promise<MfaPendingClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope !== 'mfa-pending') return null;
    if (typeof payload.userId !== 'string') return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export interface MfaSetupClaims {
  userId: string;
  secret: string;
}

/** Carries the unpersisted TOTP secret through the two-step setup. */
export async function createMfaSetupToken(userId: string, secret: string): Promise<string> {
  return new jose.SignJWT({ userId, secret, scope: 'mfa-setup' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(getJwtSecret());
}

export async function verifyMfaSetupToken(token: string): Promise<MfaSetupClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope !== 'mfa-setup') return null;
    if (typeof payload.userId !== 'string' || typeof payload.secret !== 'string') return null;
    return { userId: payload.userId, secret: payload.secret };
  } catch {
    return null;
  }
}

export interface PasskeyRegistrationClaims {
  userId: string;
  challenge: string; // base64url
}

/** Carries the registration challenge through the two-step registration flow. */
export async function createPasskeyRegistrationToken(userId: string, challenge: string): Promise<string> {
  return new jose.SignJWT({ userId, challenge, scope: 'passkey-registration' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(getJwtSecret());
}

export async function verifyPasskeyRegistrationToken(token: string): Promise<PasskeyRegistrationClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope !== 'passkey-registration') return null;
    if (typeof payload.userId !== 'string' || typeof payload.challenge !== 'string') return null;
    return { userId: payload.userId, challenge: payload.challenge };
  } catch {
    return null;
  }
}

export interface PasskeyAuthenticationClaims {
  userId: string;
  challenge: string;
}

/** Carries the authentication challenge through the two-step auth flow. */
export async function createPasskeyAuthenticationToken(userId: string, challenge: string): Promise<string> {
  return new jose.SignJWT({ userId, challenge, scope: 'passkey-authentication' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(getJwtSecret());
}

export async function verifyPasskeyAuthenticationToken(token: string): Promise<PasskeyAuthenticationClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope !== 'passkey-authentication') return null;
    if (typeof payload.userId !== 'string' || typeof payload.challenge !== 'string') return null;
    return { userId: payload.userId, challenge: payload.challenge };
  } catch {
    return null;
  }
}

export type PasskeyReauthAction =
  | 'disable-mfa'
  | 'regenerate-codes'
  | 'delete-passkey'
  | 'change-password';

export interface PasskeyReauthClaims {
  userId: string;
  challenge: string;
  action: PasskeyReauthAction;
}

/**
 * Carries a reauth challenge for destructive ops (disable MFA, regenerate codes,
 * delete passkey). Bound to a specific action so a token issued for one operation
 * cannot be replayed against a different destructive endpoint.
 */
export async function createPasskeyReauthToken(
  userId: string,
  challenge: string,
  action: PasskeyReauthAction,
): Promise<string> {
  return new jose.SignJWT({ userId, challenge, action, scope: 'passkey-reauth' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(getJwtSecret());
}

export async function verifyPasskeyReauthToken(token: string): Promise<PasskeyReauthClaims | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), JWT_VERIFY_OPTIONS);
    if (payload.scope !== 'passkey-reauth') return null;
    if (typeof payload.userId !== 'string' || typeof payload.challenge !== 'string') return null;
    const action = payload.action;
    if (
      action !== 'disable-mfa' &&
      action !== 'regenerate-codes' &&
      action !== 'delete-passkey' &&
      action !== 'change-password'
    ) return null;
    return { userId: payload.userId, challenge: payload.challenge, action };
  } catch {
    return null;
  }
}
