import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Produce an opaque `payload.sig` state token binding a serverId, valid ~1h. */
export function signInstallState(serverId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ serverId, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify a state token; returns the serverId or null if invalid/expired. */
export function verifyInstallState(state: string, secret: string): string | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { serverId, iat } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof serverId !== 'string' || typeof iat !== 'number') return null;
    if (Date.now() - iat > MAX_AGE_MS) return null;
    return serverId;
  } catch {
    return null;
  }
}
