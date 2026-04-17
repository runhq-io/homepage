import { describe, it, expect, beforeEach } from 'vitest';

import { generateServerSessionToken } from './ServerSessionService';

describe('generateServerSessionToken TTL', () => {
  beforeEach(() => {
    process.env.SERVER_SESSION_SECRET = 'test-secret-at-least-32-characters-long';
  });

  function decodePayload(token: string): { iat: number; exp: number } {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  }

  it('default TTL is 3600 (unchanged)', async () => {
    const token = await generateServerSessionToken('user-1', 'server-1');
    const { iat, exp } = decodePayload(token);
    expect(exp - iat).toBe(3600);
  });

  it('honors explicit TTL', async () => {
    const token = await generateServerSessionToken('user-1', 'server-1', 300);
    const { iat, exp } = decodePayload(token);
    expect(exp - iat).toBe(300);
  });

  it('caps at 86400', async () => {
    const token = await generateServerSessionToken('user-1', 'server-1', 999999);
    const { iat, exp } = decodePayload(token);
    expect(exp - iat).toBe(86400);
  });

  it('rejects non-positive TTL (0)', async () => {
    await expect(generateServerSessionToken('user-1', 'server-1', 0)).rejects.toThrow(
      'expiresInSeconds',
    );
  });

  it('rejects non-positive TTL (-1)', async () => {
    await expect(generateServerSessionToken('user-1', 'server-1', -1)).rejects.toThrow(
      'expiresInSeconds',
    );
  });
});
