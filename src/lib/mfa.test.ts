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
