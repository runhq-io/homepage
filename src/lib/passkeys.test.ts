import { describe, it, expect, beforeEach } from 'vitest';
import { getRpConfig, defaultNickname } from './passkeys';

beforeEach(() => {
  process.env.CLIENT_URL = 'https://test.example.com';
  delete process.env.APP_URL;
  delete process.env.WEBAUTHN_RP_NAME;
});

describe('getRpConfig', () => {
  it('derives config from CLIENT_URL', () => {
    const cfg = getRpConfig();
    expect(cfg).toEqual({
      rpID: 'test.example.com',
      rpName: 'RunHQ',
      expectedOrigin: 'https://test.example.com',
    });
  });

  it('falls back to APP_URL when CLIENT_URL not set', () => {
    delete process.env.CLIENT_URL;
    process.env.APP_URL = 'https://app.example.com:8443';
    const cfg = getRpConfig();
    expect(cfg.rpID).toBe('app.example.com');
    expect(cfg.expectedOrigin).toBe('https://app.example.com:8443');
  });

  it('strips path and query from the origin', () => {
    process.env.CLIENT_URL = 'https://app.example.com/some/path?q=1';
    expect(getRpConfig().expectedOrigin).toBe('https://app.example.com');
  });

  it('uses WEBAUTHN_RP_NAME override', () => {
    process.env.WEBAUTHN_RP_NAME = 'MyApp';
    expect(getRpConfig().rpName).toBe('MyApp');
  });

  it('throws when neither CLIENT_URL nor APP_URL is set', () => {
    delete process.env.CLIENT_URL;
    delete process.env.APP_URL;
    expect(() => getRpConfig()).toThrow(/CLIENT_URL/);
  });

  it('throws when URL is malformed', () => {
    process.env.CLIENT_URL = 'not a url';
    expect(() => getRpConfig()).toThrow(/not a valid URL/);
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
