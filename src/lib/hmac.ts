import { createHmac, timingSafeEqual } from 'node:crypto';

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function signPayload(secret: string, timestamp: string, body: string): string {
  const h = createHmac('sha256', secret);
  h.update(`${timestamp}.${body}`);
  return `sha256=${h.digest('hex')}`;
}

export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = signPayload(secret, timestamp, body);
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function isWithinReplayWindow(timestamp: string, now: number = Date.now()): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) <= REPLAY_WINDOW_MS;
}
