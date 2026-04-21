/**
 * Passkey (WebAuthn) configuration and small helpers.
 *
 * RP (Relying Party) config comes from env:
 *   WEBAUTHN_RP_ID      — domain the passkey is bound to (e.g., 'app.runhq.io')
 *   WEBAUTHN_RP_NAME    — display name in OS prompts (default: 'RunHQ')
 *   WEBAUTHN_ORIGIN     — full origin for verification (e.g., 'https://app.runhq.io')
 *
 * These must exactly match the browsing origin or verifications fail.
 */

export interface PasskeyRpConfig {
  rpID: string;
  rpName: string;
  expectedOrigin: string;
}

export function getRpConfig(): PasskeyRpConfig {
  const rpID = process.env.WEBAUTHN_RP_ID;
  const expectedOrigin = process.env.WEBAUTHN_ORIGIN;
  const rpName = process.env.WEBAUTHN_RP_NAME || 'RunHQ';
  if (!rpID) throw new Error('[Passkeys] WEBAUTHN_RP_ID must be set');
  if (!expectedOrigin) throw new Error('[Passkeys] WEBAUTHN_ORIGIN must be set');
  return { rpID, rpName, expectedOrigin };
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
