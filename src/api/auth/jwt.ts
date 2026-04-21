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

let _jwtSecret: Uint8Array | null = null;

function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-production';
    if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
      throw new Error('[JWT] CRITICAL: JWT_SECRET not set in production!');
    }
    _jwtSecret = new TextEncoder().encode(secret);
  }
  return _jwtSecret;
}

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
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    if (payload.scope) return null;
    if (typeof payload.userId === 'string') return payload.userId;
    return null;
  } catch {
    return null;
  }
}

export async function extractUserIdFromToken(token: string): Promise<string | null> {
  return verifyToken(token);
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
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
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
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
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
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
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
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    if (payload.scope !== 'passkey-authentication') return null;
    if (typeof payload.userId !== 'string' || typeof payload.challenge !== 'string') return null;
    return { userId: payload.userId, challenge: payload.challenge };
  } catch {
    return null;
  }
}
