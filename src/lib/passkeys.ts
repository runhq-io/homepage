/**
 * Passkey (WebAuthn) configuration and small helpers.
 *
 * RP (Relying Party) config is derived from the client app URL so there's
 * one source of truth for where the browser lives. We read, in order:
 *   1. CLIENT_URL       (primary — used for invite links and client-facing UI)
 *   2. APP_URL          (fallback — used by auth email routes)
 *
 * From the resolved URL we derive:
 *   - rpID           = hostname           (what the passkey is bound to)
 *   - expectedOrigin = scheme + host+port (what the server verifies against)
 *
 * Only WEBAUTHN_RP_NAME is a dedicated env — display-only string shown in
 * OS prompts (e.g., "RunHQ wants to create a passkey"). Defaults to 'RunHQ'.
 */

export interface PasskeyRpConfig {
  rpID: string;
  rpName: string;
  expectedOrigin: string;
}

export function getRpConfig(): PasskeyRpConfig {
  const clientUrl = process.env.CLIENT_URL || process.env.APP_URL;
  if (!clientUrl) {
    throw new Error('[Passkeys] CLIENT_URL must be set to derive WebAuthn RP config');
  }
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    throw new Error(`[Passkeys] CLIENT_URL is not a valid URL: ${clientUrl}`);
  }
  return {
    rpID: parsed.hostname,
    rpName: process.env.WEBAUTHN_RP_NAME || 'RunHQ',
    expectedOrigin: parsed.origin,
  };
}

/**
 * Produce a reasonable default nickname at registration time from the signals
 * we have: transports, device_type (singleDevice | multiDevice), and the
 * browser's User-Agent string.
 */
export function defaultNickname(
  transports: string[],
  deviceType: 'singleDevice' | 'multiDevice',
  userAgent: string | null,
): string {
  const ua = (userAgent || '').toLowerCase();

  if (transports.includes('usb') || transports.includes('nfc')) {
    return 'Security Key';
  }

  if (transports.includes('internal')) {
    if (deviceType === 'multiDevice') {
      if (ua.includes('mac os') || ua.includes('iphone') || ua.includes('ipad')) return 'iCloud Keychain';
      if (ua.includes('android')) return 'Google Password Manager';
      if (ua.includes('windows')) return 'Windows Hello';
    }
    if (ua.includes('mac os') || ua.includes('iphone') || ua.includes('ipad')) return 'Apple device';
    if (ua.includes('android')) return 'Android device';
    if (ua.includes('windows')) return 'Windows Hello';
  }

  const date = new Date().toISOString().slice(0, 10);
  return `Passkey added ${date}`;
}
