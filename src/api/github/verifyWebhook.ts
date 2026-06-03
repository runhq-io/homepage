import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook's `x-hub-signature-256` header against the raw body.
 * Constant-time comparison; returns false on any mismatch or missing signature.
 */
export function verifyGithubWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
