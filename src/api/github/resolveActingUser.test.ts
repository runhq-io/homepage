import { describe, it, expect, beforeEach } from 'vitest';

import { generateServerSessionToken } from '../services/ServerSessionService';
import { createToken, extractUserIdFromToken } from '../auth/jwt';
import { _resetServerSessionKeyPairCache } from '../auth/serverSessionKeys';
import { resolveGithubActingUser } from './resolveActingUser';

/**
 * Regression for the GitHub "Install / configure" 401.
 *
 * The browser holds a workspace **server-session token** (EdDSA, scope
 * `server:connect`) and the workspace server forwards it verbatim to the BE
 * GitHub broker. The broker resolves the acting user from that Bearer. It used
 * to call only `extractUserIdFromToken` (HS256 user JWT / opaque OAuth), which
 * cannot verify an EdDSA token — so every install/connect/browse returned
 * `401 User authentication required`.
 */
describe('resolveGithubActingUser', () => {
  beforeEach(() => {
    // Force ephemeral in-memory Ed25519 keys (NODE_ENV=test) so mint+verify use
    // the same keypair within this process.
    delete process.env.SERVER_SESSION_PRIVATE_KEY_PEM;
    delete process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
    _resetServerSessionKeyPairCache();
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-xx';
  });

  it('REPRODUCTION: the old resolver cannot verify a server-session token', async () => {
    const sessionToken = await generateServerSessionToken('user-1', 'ws_abc');
    // This is exactly what the broker did before the fix → null → 401.
    expect(await extractUserIdFromToken(sessionToken)).toBeNull();
  });

  it('resolves the user from a workspace server-session token (the product path)', async () => {
    const sessionToken = await generateServerSessionToken('user-1', 'ws_abc');
    expect(await resolveGithubActingUser(sessionToken)).toBe('user-1');
  });

  it('still resolves a direct user session JWT (back-compat)', async () => {
    const userJwt = await createToken('user-2');
    expect(await resolveGithubActingUser(userJwt)).toBe('user-2');
  });

  it('returns null for a missing bearer', async () => {
    expect(await resolveGithubActingUser(null)).toBeNull();
  });

  it('returns null for a garbage token', async () => {
    expect(await resolveGithubActingUser('not-a-real-token')).toBeNull();
  });
});
