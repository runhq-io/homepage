import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface InstallStatePayload {
  serverId: string;
  /** RunHQ user who initiated the install (recorded as connector). */
  userId: string | null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Produce an opaque `payload.sig` state token binding a serverId + the acting
 * userId, valid ~1h. The userId lets the setup callback record who connected
 * the installation (audit) and associate it with the originating workspace.
 */
export function signInstallState(serverId: string, userId: string | null, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ serverId, userId, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify a state token; returns the { serverId, userId } or null if invalid/expired. */
export function verifyInstallState(state: string, secret: string): InstallStatePayload | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { serverId, userId, iat } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof serverId !== 'string' || typeof iat !== 'number') return null;
    if (userId !== null && typeof userId !== 'string') return null;
    if (Date.now() - iat > MAX_AGE_MS) return null;
    return { serverId, userId: userId ?? null };
  } catch {
    return null;
  }
}
