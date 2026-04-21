import { describe, it, expect, beforeAll } from 'vitest';
import * as jose from 'jose';
import {
  createToken, verifyToken,
  createMfaPendingToken, verifyMfaPendingToken,
  createMfaSetupToken, verifyMfaSetupToken,
  createPasskeyRegistrationToken, verifyPasskeyRegistrationToken,
  createPasskeyAuthenticationToken, verifyPasskeyAuthenticationToken,
  createPasskeyReauthToken, verifyPasskeyReauthToken,
} from './jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-for-jwt-scope-tests';
});

describe('JWT scope isolation', () => {
  it('session verify rejects an mfa-pending token', async () => {
    const t = await createMfaPendingToken('user-1');
    expect(await verifyToken(t)).toBeNull();
  });

  it('session verify rejects an mfa-setup token', async () => {
    const t = await createMfaSetupToken('user-1', 'JBSWY3DPEHPK3PXP');
    expect(await verifyToken(t)).toBeNull();
  });

  it('mfa-pending verify rejects a session token', async () => {
    const t = await createToken('user-1');
    expect(await verifyMfaPendingToken(t)).toBeNull();
  });

  it('mfa-pending verify rejects an mfa-setup token', async () => {
    const t = await createMfaSetupToken('user-1', 's');
    expect(await verifyMfaPendingToken(t)).toBeNull();
  });

  it('mfa-setup verify rejects an mfa-pending token', async () => {
    const t = await createMfaPendingToken('user-1');
    expect(await verifyMfaSetupToken(t)).toBeNull();
  });

  it('round-trips mfa-pending', async () => {
    const t = await createMfaPendingToken('user-7');
    const claims = await verifyMfaPendingToken(t);
    expect(claims).toEqual({ userId: 'user-7' });
  });

  it('round-trips mfa-setup', async () => {
    const t = await createMfaSetupToken('user-7', 'JBSWY3DPEHPK3PXP');
    const claims = await verifyMfaSetupToken(t);
    expect(claims).toEqual({ userId: 'user-7', secret: 'JBSWY3DPEHPK3PXP' });
  });

  it('round-trips a session token', async () => {
    const t = await createToken('user-9');
    expect(await verifyToken(t)).toBe('user-9');
  });
});

describe('passkey JWT scopes', () => {
  it('registration token roundtrips', async () => {
    const t = await createPasskeyRegistrationToken('u1', 'ch1');
    expect(await verifyPasskeyRegistrationToken(t)).toEqual({ userId: 'u1', challenge: 'ch1' });
  });

  it('authentication token roundtrips', async () => {
    const t = await createPasskeyAuthenticationToken('u2', 'ch2');
    expect(await verifyPasskeyAuthenticationToken(t)).toEqual({ userId: 'u2', challenge: 'ch2' });
  });

  it('session verify rejects passkey-registration token', async () => {
    const t = await createPasskeyRegistrationToken('u1', 'c');
    expect(await verifyToken(t)).toBeNull();
  });

  it('session verify rejects passkey-authentication token', async () => {
    const t = await createPasskeyAuthenticationToken('u1', 'c');
    expect(await verifyToken(t)).toBeNull();
  });

  it('passkey-registration verify rejects other scopes', async () => {
    const s = await createToken('u1');
    const p = await createPasskeyAuthenticationToken('u1', 'c');
    expect(await verifyPasskeyRegistrationToken(s)).toBeNull();
    expect(await verifyPasskeyRegistrationToken(p)).toBeNull();
  });

  it('passkey-authentication verify rejects other scopes', async () => {
    const s = await createToken('u1');
    const p = await createPasskeyRegistrationToken('u1', 'c');
    expect(await verifyPasskeyAuthenticationToken(s)).toBeNull();
    expect(await verifyPasskeyAuthenticationToken(p)).toBeNull();
  });
});

describe('passkey-reauth scope', () => {
  it('roundtrips with action', async () => {
    const t = await createPasskeyReauthToken('u1', 'c1', 'disable-mfa');
    expect(await verifyPasskeyReauthToken(t)).toEqual({
      userId: 'u1', challenge: 'c1', action: 'disable-mfa',
    });
  });

  it('rejects tokens without valid action claim', async () => {
    // Manually craft a token lacking action:
    const bad = await new jose.SignJWT({ userId: 'u1', challenge: 'c', scope: 'passkey-reauth' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(await verifyPasskeyReauthToken(bad)).toBeNull();
  });

  it('session verify rejects', async () => {
    const t = await createPasskeyReauthToken('u1', 'c', 'disable-mfa');
    expect(await verifyToken(t)).toBeNull();
  });

  it('other scope verifiers reject', async () => {
    const t = await createPasskeyReauthToken('u1', 'c', 'disable-mfa');
    expect(await verifyPasskeyRegistrationToken(t)).toBeNull();
    expect(await verifyPasskeyAuthenticationToken(t)).toBeNull();
  });

  it('reauth verify rejects other scopes', async () => {
    const s = await createToken('u1');
    const p1 = await createPasskeyRegistrationToken('u1', 'c');
    const p2 = await createPasskeyAuthenticationToken('u1', 'c');
    expect(await verifyPasskeyReauthToken(s)).toBeNull();
    expect(await verifyPasskeyReauthToken(p1)).toBeNull();
    expect(await verifyPasskeyReauthToken(p2)).toBeNull();
  });
});
