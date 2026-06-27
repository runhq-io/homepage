/**
 * Allowlist for user-supplied `redirect` URLs in auth flows (verify-email,
 * forgot-password, etc.).
 *
 * Without an allowlist, an attacker who can trigger an outbound email (forgot-
 * password, resend-verification) can poison the embedded link's `redirect`
 * parameter to point at an attacker-controlled domain. The user receives a
 * legitimate runhq.io email, clicks the link, and lands on a phishing page
 * that mimics login.
 *
 * Policy: only `*.runhq.io` and localhost (dev) hosts are permitted.
 */

const ALLOWED_HOST_SUFFIXES = ['.runhq.io'];
const ALLOWED_LOCAL_PREFIXES = ['http://localhost:', 'http://127.0.0.1:'];

/**
 * Returns the supplied redirect URL if it points at an allowed host, otherwise
 * null. Caller should fall back to APP_URL / NEXTAUTH_URL when this returns
 * null.
 */
export function safeRedirectUrl(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  if (ALLOWED_LOCAL_PREFIXES.some((prefix) => input.startsWith(prefix))) {
    return input;
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'runhq.io') return input;
  if (ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return input;
  return null;
}
