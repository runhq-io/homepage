/**
 * Shared JWT token signing/verification.
 * Used by both the Hono HTTP server and WebSocket server.
 */
import * as jose from 'jose';

// Read JWT secret lazily — module-load-time reads can race with env injection.
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

/**
 * Create a signed JWT token for a user
 */
export async function createToken(userId: string): Promise<string> {
  return await new jose.SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getJwtSecret());
}

/**
 * Verify and decode a JWT token.
 * Returns userId if valid, null if invalid or expired.
 */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    if (typeof payload.userId === 'string') {
      return payload.userId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract userId from a Bearer token (JWT or legacy base64 format).
 * Tries JWT first, then falls back to legacy format.
 */
export async function extractUserIdFromToken(token: string): Promise<string | null> {
  // Try JWT first
  const userId = await verifyToken(token);
  if (userId) return userId;

  // Fallback: legacy base64 JSON format
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (decoded.userId && decoded.exp && decoded.exp > Date.now()) {
      console.warn('[JWT] Using legacy base64 token - client should update');
      return decoded.userId;
    }
  } catch {
    // Token decode failed
  }

  return null;
}
