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
 *
 * ## Signing
 *
 * Tokens are signed with **EdDSA** (Ed25519). The private key lives only on
 * the backend; workspace machines hold the public key and verify without the
 * ability to sign — closing the forgery path a workspace root user previously
 * had with a shared HMAC secret.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getServerSessionKeyPair } from '../auth/serverSessionKeys';

// Session token payload (extends standard JWT claims)
export interface ServerSessionPayload extends JWTPayload {
  userId: string;
  serverId: string;
  scope: 'server:connect';
  userName?: string;
  userEmail?: string;
  serverRole?: 'owner' | 'member';
}

/**
 * Generate a signed server session JWT token.
 */
export async function generateServerSessionToken(
  userId: string,
  serverId: string,
  expiresInSeconds: number = 3600, // 1 hour default
  options?: { userName?: string; userEmail?: string; serverRole?: 'owner' | 'member' },
): Promise<string> {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error(`Invalid expiresInSeconds: ${expiresInSeconds}`);
  }
  const ttl = Math.min(expiresInSeconds, 86400);

  const claims: ServerSessionPayload = {
    userId,
    serverId,
    scope: 'server:connect',
    ...(options?.userName && { userName: options.userName }),
    ...(options?.userEmail && { userEmail: options.userEmail }),
    ...(options?.serverRole && { serverRole: options.serverRole }),
  };

  const { privateKey, kid } = await getServerSessionKeyPair();

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

/**
 * Verify and decode a server session JWT token.
 *
 * Only EdDSA is accepted. Any other algorithm (including HS256 or `none`) is
 * rejected — we do not want to leave the legacy forgery path in place even as
 * a fallback.
 */
export async function verifyServerSessionToken(token: string): Promise<ServerSessionPayload | null> {
  try {
    const { publicKey } = await getServerSessionKeyPair();
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ['EdDSA'] });

    const serverPayload = payload as ServerSessionPayload;
    if (!serverPayload.userId || !serverPayload.serverId) {
      console.log('[ServerSessionService] Missing required fields in token');
      return null;
    }

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
