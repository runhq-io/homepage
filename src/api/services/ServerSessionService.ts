/**
 * Server Session Service
 *
 * Handles generation and verification of server-scoped JWT session tokens
 * for secure client-server communication.
 *
 * These tokens:
 * - Are scoped to a specific server (can't be used for other servers)
 * - Have limited scope (only "server:connect", not full API access)
 * - Are short-lived (default 1 hour)
 * - Can be verified by Servers without exposing user's full cloudToken
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

// Session token payload (extends standard JWT claims)
export interface ServerSessionPayload extends JWTPayload {
  userId: string;
  serverId: string;
  scope: 'server:connect';
  userName?: string;
  userEmail?: string;
  serverRole?: 'owner' | 'member';
}

// Get secret from environment (should be set in production)
function getSecret(): Uint8Array {
  const secret = process.env.SERVER_SESSION_SECRET;
  if (!secret) {
    // In development, use a default (NOT for production!)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SERVER_SESSION_SECRET must be set in production');
    }
    return new TextEncoder().encode('dev-server-session-secret-do-not-use-in-production');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Generate a signed server session JWT token
 */
export async function generateServerSessionToken(
  userId: string,
  serverId: string,
  expiresInSeconds: number = 3600, // 1 hour default
  options?: { userName?: string; userEmail?: string; serverRole?: 'owner' | 'member' },
): Promise<string> {
  const token = await new SignJWT({
    userId,
    serverId,
    scope: 'server:connect',
    ...(options?.userName && { userName: options.userName }),
    ...(options?.userEmail && { userEmail: options.userEmail }),
    ...(options?.serverRole && { serverRole: options.serverRole }),
  } as ServerSessionPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .setJti(crypto.randomUUID())
    .sign(getSecret());

  return token;
}

/**
 * Verify and decode a server session JWT token
 */
export async function verifyServerSessionToken(token: string): Promise<ServerSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });

    // Verify required fields
    const serverPayload = payload as ServerSessionPayload;
    if (!serverPayload.userId || !serverPayload.serverId) {
      console.log('[ServerSessionService] Missing required fields in token');
      return null;
    }

    // Verify scope
    if (serverPayload.scope !== 'server:connect') {
      console.log('[ServerSessionService] Invalid scope');
      return null;
    }

    return serverPayload;
  } catch (error) {
    if (error instanceof Error) {
      console.log('[ServerSessionService] Token verification failed:', error.message);
    }
    return null;
  }
}

/**
 * Extract server ID from token without full verification
 * (useful for routing before verification)
 */
export function extractServerIdFromToken(token: string): string | null {
  try {
    // JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as ServerSessionPayload;

    return payload.serverId || null;
  } catch {
    return null;
  }
}
