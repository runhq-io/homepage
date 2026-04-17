import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, decryptSecret, _resetMfaKeyForTesting } from './mfa';

describe('MFA secret encryption', () => {
  beforeEach(() => {
    const key = Buffer.alloc(32, 0x42).toString('base64');
    process.env.MFA_ENCRYPTION_KEY = key;
    _resetMfaKeyForTesting();
  });

  it('roundtrips a plaintext secret', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const enc = encryptSecret(plaintext);
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.iv).toBeTruthy();
    expect(enc.authTag).toBeTruthy();
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encryptSecret('secret');
    const b = encryptSecret('secret');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(decryptSecret(a)).toBe('secret');
    expect(decryptSecret(b)).toBe('secret');
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptSecret('secret');
    const tampered = { ...enc, ciphertext: Buffer.from('deadbeef', 'hex').toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const enc = encryptSecret('secret');
    const tampered = { ...enc, authTag: Buffer.alloc(16, 0).toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

import { generateTotpSecret, verifyTotp, buildOtpAuthUrl, generateQrDataUrl } from './mfa';
import { authenticator } from 'otplib';

describe('TOTP', () => {
  it('verifies a freshly generated code', () => {
    const secret = generateTotpSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects an obviously wrong code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('rejects non-6-digit input', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });

  it('builds otpauth URL with issuer and email', () => {
    const url = buildOtpAuthUrl('JBSWY3DPEHPK3PXP', 'user@example.com');
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('RunHQ');
    expect(url).toContain('user%40example.com');
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
  });

  it('generates a data URL QR code', async () => {
    const url = await generateQrDataUrl('JBSWY3DPEHPK3PXP', 'user@example.com');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
