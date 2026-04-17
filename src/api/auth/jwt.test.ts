import { describe, it, expect, beforeAll } from 'vitest';
import {
  createToken, verifyToken,
  createMfaPendingToken, verifyMfaPendingToken,
  createMfaSetupToken, verifyMfaSetupToken,
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
