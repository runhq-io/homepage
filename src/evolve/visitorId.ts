/**
 * The SDK's visitor id, from the page's side (R114d).
 *
 * Assignment hashes the SDK's anon id, so the arm this page paints must be
 * computed from the very id the SDK will record the exposure under. These are
 * the SDK's own storage keys and formats (be/public/widget.js: TRACK_ANON_KEY,
 * `trackResolveAnonId`, `trackCookieMirror`, `trackRandomId`,
 * TRACK_SUPPRESS_KEY). If the SDK changes them, change these with it.
 *
 * Only ever called for a visitor who has consented to analytics: the id is
 * exactly the identifier that consent is about.
 */

export const SDK_ANON_KEY = 'rw_anon_id';
const SDK_SUPPRESS_KEY = 'rw_track_off_until';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 22;
const COOKIE_MAX_AGE_S = 2 * 365 * 24 * 60 * 60;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function cookieRead(): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${SDK_ANON_KEY}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** The id the SDK would use, if it has one. */
export function readVisitorId(): string | null {
  return storageGet(SDK_ANON_KEY) || cookieRead();
}

function mintId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET.charAt(b % ID_ALPHABET.length);
  return out;
}

function persist(id: string): void {
  try {
    localStorage.setItem(SDK_ANON_KEY, id);
  } catch {
    // Checked by reading back.
  }
  try {
    const host = window.location.hostname || '';
    const parts = host.split('.');
    const domain = parts.length > 2 ? `.${parts.slice(-2).join('.')}` : host;
    document.cookie =
      `${SDK_ANON_KEY}=${encodeURIComponent(id)};path=/;max-age=${COOKIE_MAX_AGE_S}` +
      `${domain ? `;domain=${domain}` : ''};SameSite=Lax`;
  } catch {
    // As above.
  }
}

/**
 * The SDK's id, minted and stored under its key when there is none. Null when
 * storage cannot keep it: the SDK would then mint a different id, and an arm
 * painted for this one could never be counted.
 */
export function ensureVisitorId(): string | null {
  const existing = readVisitorId();
  if (existing) {
    persist(existing);
    return existing;
  }
  const id = mintId();
  persist(id);
  return readVisitorId() === id ? id : null;
}

/** The SDK's "collect said disabled" latch: its tracker will not start, so nothing is counted. */
export function trackingSuppressed(): boolean {
  const until = Number(storageGet(SDK_SUPPRESS_KEY) || 0);
  return Number.isFinite(until) && until > Date.now();
}
