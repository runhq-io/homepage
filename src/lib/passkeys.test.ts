import { describe, it, expect, beforeEach } from 'vitest';
import { getRpConfig, defaultNickname } from './passkeys';

beforeEach(() => {
  process.env.WEBAUTHN_RP_ID = 'test.example.com';
  process.env.WEBAUTHN_ORIGIN = 'https://test.example.com';
  delete process.env.WEBAUTHN_RP_NAME;
});

describe('getRpConfig', () => {
  it('returns config from env', () => {
    const cfg = getRpConfig();
    expect(cfg).toEqual({
      rpID: 'test.example.com',
      rpName: 'RunHQ',
      expectedOrigin: 'https://test.example.com',
    });
  });

  it('uses WEBAUTHN_RP_NAME override', () => {
    process.env.WEBAUTHN_RP_NAME = 'MyApp';
    expect(getRpConfig().rpName).toBe('MyApp');
  });

  it('throws when rpID missing', () => {
    delete process.env.WEBAUTHN_RP_ID;
    expect(() => getRpConfig()).toThrow(/WEBAUTHN_RP_ID/);
  });

  it('throws when origin missing', () => {
    delete process.env.WEBAUTHN_ORIGIN;
    expect(() => getRpConfig()).toThrow(/WEBAUTHN_ORIGIN/);
  });
});

describe('defaultNickname', () => {
  it('detects iCloud Keychain on Mac with synced platform authenticator', () => {
    expect(defaultNickname(['internal'], 'multiDevice', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)'))
      .toBe('iCloud Keychain');
  });

  it('detects Google Password Manager on Android', () => {
    expect(defaultNickname(['internal'], 'multiDevice', 'Mozilla/5.0 (Linux; Android 13)'))
      .toBe('Google Password Manager');
  });

  it('detects Windows Hello', () => {
    expect(defaultNickname(['internal'], 'multiDevice', 'Mozilla/5.0 (Windows NT 10.0)'))
      .toBe('Windows Hello');
  });

  it('labels USB security keys', () => {
    expect(defaultNickname(['usb'], 'singleDevice', 'anything')).toBe('Security Key');
  });

  it('labels NFC security keys', () => {
    expect(defaultNickname(['nfc'], 'singleDevice', 'anything')).toBe('Security Key');
  });

  it('falls back to dated label', () => {
    const nick = defaultNickname([], 'singleDevice', null);
    expect(nick).toMatch(/^Passkey added \d{4}-\d{2}-\d{2}$/);
  });
});
