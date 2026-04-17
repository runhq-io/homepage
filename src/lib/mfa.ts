/**
 * MFA utilities: TOTP generation/verification, secret encryption at rest,
 * recovery code generation.
 *
 * TOTP secrets are stored AES-256-GCM encrypted. The encryption key is
 * MFA_ENCRYPTION_KEY (32 random bytes, base64-encoded) and MUST be set in
 * production — rotating it invalidates all enrolled TOTP secrets.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;

let _mfaKey: Buffer | null = null;

function getMfaKey(): Buffer {
  if (_mfaKey) return _mfaKey;
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[MFA] CRITICAL: MFA_ENCRYPTION_KEY not set in production');
    }
    const devKey = 'dev-mfa-key-do-not-use-in-production-0000';
    _mfaKey = Buffer.from(devKey.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH), 'utf8');
    return _mfaKey;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`[MFA] MFA_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${buf.length})`);
  }
  _mfaKey = buf;
  return _mfaKey;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getMfaKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptSecret(enc: EncryptedSecret): string {
  const key = getMfaKey();
  const iv = Buffer.from(enc.iv, 'base64');
  const authTag = Buffer.from(enc.authTag, 'base64');
  const ciphertext = Buffer.from(enc.ciphertext, 'base64');
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error('[MFA] Invalid auth tag length');
  if (iv.length !== IV_LENGTH) throw new Error('[MFA] Invalid IV length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

export function _resetMfaKeyForTesting() {
  _mfaKey = null;
}

import { authenticator } from 'otplib';
import QRCode from 'qrcode';

authenticator.options = { step: 30, window: 1, digits: 6 };

const ISSUER = 'RunHQ';

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function buildOtpAuthUrl(secret: string, accountEmail: string): string {
  return authenticator.keyuri(accountEmail, ISSUER, secret);
}

export async function generateQrDataUrl(secret: string, accountEmail: string): Promise<string> {
  const url = buildOtpAuthUrl(secret, accountEmail);
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 256 });
}

export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}
