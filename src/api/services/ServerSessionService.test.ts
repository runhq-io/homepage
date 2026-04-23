import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { importSPKI, jwtVerify, decodeProtectedHeader } from 'jose';

import { generateServerSessionToken, verifyServerSessionToken } from './ServerSessionService';
import { _resetServerSessionKeyPairCache } from '../auth/serverSessionKeys';

// Ed25519 keypair generated once for this suite.
const TEST_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKaAL1DsnPJG1yiFcttnDYKqkZiwkxvwl1SxoJiGXkkp
-----END PRIVATE KEY-----`;
const TEST_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0sjXscAx1uBS3Ny36JpFbfQva3FF6Rn5Y1foMvJ0HEY=
-----END PUBLIC KEY-----`;

describe('generateServerSessionToken TTL', () => {
  beforeEach(() => {
    process.env.SERVER_SESSION_SECRET = 'test-secret-at-least-32-characters-long';
    delete process.env.SERVER_SESSION_PRIVATE_KEY_PEM;
    delete process.env.SERVER_SESSION_PUBLIC_KEY_PEM;
    _resetServerSessionKeyPairCache();
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

/**
 * Asymmetric signing tests — the security fix.
 *
 * When the keypair is configured, tokens must be signed with EdDSA and
 * verifiable with the public key (which is what gets distributed to
 * workspace machines).
 */
describe('generateServerSessionToken — EdDSA signing', () => {
  beforeEach(() => {
    process.env.SERVER_SESSION_PRIVATE_KEY_PEM = TEST_PRIVATE_PEM;
    process.env.SERVER_SESSION_PUBLIC_KEY_PEM = TEST_PUBLIC_PEM;
    delete process.env.SERVER_SESSION_SECRET;
    _resetServerSessionKeyPairCache();
  });

  afterEach(() => {
    _resetServerSessionKeyPairCache();
  });

  it('signs tokens with EdDSA (not HS256) when a keypair is configured', async () => {
    const token = await generateServerSessionToken('u', 's');
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBeTruthy();
  });

  it('produces tokens that verify against the public key', async () => {
    const token = await generateServerSessionToken('u', 's');
    const pubKey = await importSPKI(TEST_PUBLIC_PEM, 'EdDSA');
    const { payload } = await jwtVerify(token, pubKey, { algorithms: ['EdDSA'] });
    expect(payload.userId).toBe('u');
    expect(payload.serverId).toBe('s');
    expect(payload.scope).toBe('server:connect');
  });

  it('round-trips through verifyServerSessionToken', async () => {
    const token = await generateServerSessionToken('u', 's', 3600, { serverRole: 'owner' });
    const decoded = await verifyServerSessionToken(token);
    expect(decoded?.userId).toBe('u');
    expect(decoded?.serverId).toBe('s');
    expect(decoded?.serverRole).toBe('owner');
  });

  it('verifyServerSessionToken rejects tokens signed with an unrelated Ed25519 key (forgery attempt)', async () => {
    // Generate a DIFFERENT keypair — simulating a party who does NOT have
    // the real private key trying to pass off their own EdDSA token.
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('ed25519');
    const { SignJWT, importPKCS8 } = await import('jose');
    const otherPriv = await importPKCS8(
      other.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      'EdDSA',
    );
    const forged = await new SignJWT({ userId: 'attacker', serverId: 's', scope: 'server:connect' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(otherPriv);

    const decoded = await verifyServerSessionToken(forged);
    expect(decoded).toBeNull();
  });

  it('rejects mismatched public/private halves at load time (rotation-typo guard)', async () => {
    // Pair the "canonical" test private key with a public key from an
    // UNRELATED keypair. Loading must fail with a clear error rather than
    // silently publishing a non-matching JWKS / Fly env var.
    const { generateKeyPairSync } = await import('node:crypto');
    const unrelated = generateKeyPairSync('ed25519');
    const unrelatedPublicPem = unrelated.publicKey.export({ format: 'pem', type: 'spki' }) as string;

    process.env.SERVER_SESSION_PRIVATE_KEY_PEM = TEST_PRIVATE_PEM;
    process.env.SERVER_SESSION_PUBLIC_KEY_PEM = unrelatedPublicPem;
    _resetServerSessionKeyPairCache();

    await expect(generateServerSessionToken('u', 's')).rejects.toThrow(
      /matching Ed25519 pair/,
    );
  });

  it('rejects HS256-signed tokens outright (no legacy fallback, even if SERVER_SESSION_SECRET is present)', async () => {
    // Phase 2: the HS256 verification path has been removed entirely. Even
    // if the old shared secret env var is still set (e.g. during rollout),
    // an HS256-signed token does not verify because we only accept EdDSA.
    process.env.SERVER_SESSION_SECRET = 'some-leaked-secret';
    const { SignJWT } = await import('jose');
    const hsToken = await new SignJWT({ userId: 'x', serverId: 's', scope: 'server:connect' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('some-leaked-secret'));

    const decoded = await verifyServerSessionToken(hsToken);
    expect(decoded).toBeNull();
  });
});
