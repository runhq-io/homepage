import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  extractUserIdFromToken: vi.fn(),
  createPasskeyReauthToken: vi.fn(),
  verifyPasskeyReauthToken: vi.fn(),
  verifyPassword: vi.fn(),
  verifyPasskeyAssertion: vi.fn(),
  rateLimitCheck: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  getRpConfig: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  hashRecoveryCode: vi.fn(),
  verifyTotp: vi.fn(),
  decryptSecret: vi.fn(),
  verifyRecoveryCode: vi.fn(),
  normalizeRecoveryCode: vi.fn(),
  selectQueue: [] as any[],
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => 'and'),
  count: vi.fn(() => 'count'),
  eq: vi.fn(() => 'eq'),
  isNull: vi.fn(() => 'isNull'),
  ne: vi.fn(() => 'ne'),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
}));

vi.mock('@/db', () => ({
  db: mocks.db,
  users: {
    id: 'users.id',
    passwordHash: 'users.passwordHash',
    mfaEnabled: 'users.mfaEnabled',
    updatedAt: 'users.updatedAt',
  },
  userMfa: {
    userId: 'userMfa.userId',
    secretEncrypted: 'userMfa.secretEncrypted',
    secretIv: 'userMfa.secretIv',
    secretAuthTag: 'userMfa.secretAuthTag',
  },
  userRecoveryCodes: {
    id: 'userRecoveryCodes.id',
    userId: 'userRecoveryCodes.userId',
    usedAt: 'userRecoveryCodes.usedAt',
    codeHash: 'userRecoveryCodes.codeHash',
  },
  userPasskeys: {
    id: 'userPasskeys.id',
    userId: 'userPasskeys.userId',
    credentialId: 'userPasskeys.credentialId',
    transports: 'userPasskeys.transports',
    disabledAt: 'userPasskeys.disabledAt',
  },
}));

vi.mock('@/api/auth/jwt', () => ({
  extractUserIdFromToken: mocks.extractUserIdFromToken,
  createPasskeyReauthToken: mocks.createPasskeyReauthToken,
  verifyPasskeyReauthToken: mocks.verifyPasskeyReauthToken,
}));

vi.mock('@/lib/password', () => ({
  verifyPassword: mocks.verifyPassword,
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimit: vi.fn(() => ({ check: mocks.rateLimitCheck })),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 })),
}));

vi.mock('@/lib/passkeyVerify', () => ({
  verifyPasskeyAssertion: mocks.verifyPasskeyAssertion,
}));

vi.mock('@/lib/passkeys', () => ({
  getRpConfig: mocks.getRpConfig,
}));

vi.mock('@/lib/mfa', () => ({
  verifyTotp: mocks.verifyTotp,
  decryptSecret: mocks.decryptSecret,
  verifyRecoveryCode: mocks.verifyRecoveryCode,
  normalizeRecoveryCode: mocks.normalizeRecoveryCode,
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
}));

import { POST as passkeyReauthOptionsPost } from './reauth/options/route';
import { POST as mfaDisablePost } from '../mfa/disable/route';
import { POST as recoveryCodesPost } from '../mfa/recovery-codes/route';
import { DELETE as deletePasskey } from './[id]/route';

function makeSelectChain(result: unknown) {
  const promise = Promise.resolve(result);
  const afterWhere = {
    limit: vi.fn(async () => result),
    for: vi.fn(() => afterWhere),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };

  return {
    from: vi.fn(() => ({
      where: vi.fn(() => afterWhere),
    })),
  };
}

function makeRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: {
      Authorization: 'Bearer session-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }) as any;
}

function queueSelectResults(...results: unknown[]) {
  mocks.selectQueue.splice(0, mocks.selectQueue.length, ...results);
}

describe('passkey reauth routes', () => {
  const passkeyResponse = { id: 'cred-1' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectQueue.length = 0;

    mocks.rateLimitCheck.mockReturnValue(true);
    mocks.extractUserIdFromToken.mockResolvedValue('user-1');
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.getRpConfig.mockReturnValue({
      rpID: 'app.runhq.io',
      expectedOrigin: 'https://app.runhq.io',
    });
    mocks.generateRecoveryCodes.mockReturnValue(['alpha-bravo']);
    mocks.hashRecoveryCode.mockImplementation(async (code: string) => `hash:${code}`);
    mocks.db.select.mockImplementation(() => {
      if (mocks.selectQueue.length === 0) {
        throw new Error('Unexpected db.select() call');
      }
      return makeSelectChain(mocks.selectQueue.shift());
    });
    mocks.db.update.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
        returning: vi.fn(async () => []),
      })),
    }));
    mocks.db.delete.mockImplementation(() => ({
      where: vi.fn(async () => []),
    }));
    mocks.db.transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn({
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => []),
          returning: vi.fn(async () => []),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
      select: vi.fn(() => makeSelectChain([])),
    }));
  });

  it('rejects invalid passkey reauth actions before touching the database', async () => {
    const response = await passkeyReauthOptionsPost(
      makeRequest('http://localhost/api/auth/passkeys/reauth/options', 'POST', { action: 'wrong-action' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'action must be one of: disable-mfa, regenerate-codes, delete-passkey',
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mocks.createPasskeyReauthToken).not.toHaveBeenCalled();
  });

  it('issues a passkey reauth token bound to the requested action', async () => {
    queueSelectResults([
      { credentialId: 'cred-1', transports: ['usb'] },
      { credentialId: 'cred-2', transports: ['internal'] },
    ]);
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'challenge-123',
      rpId: 'app.runhq.io',
    });
    mocks.createPasskeyReauthToken.mockResolvedValue('reauth-token');

    const response = await passkeyReauthOptionsPost(
      makeRequest('http://localhost/api/auth/passkeys/reauth/options', 'POST', { action: 'delete-passkey' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      options: { challenge: 'challenge-123', rpId: 'app.runhq.io' },
      reauthToken: 'reauth-token',
    });
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'app.runhq.io',
      userVerification: 'required',
      allowCredentials: [
        { id: 'cred-1', transports: ['usb'] },
        { id: 'cred-2', transports: ['internal'] },
      ],
    });
    expect(mocks.createPasskeyReauthToken).toHaveBeenCalledWith(
      'user-1',
      'challenge-123',
      'delete-passkey',
    );
  });

  it('rejects disable-mfa when a passkey reauth token was minted for another action', async () => {
    queueSelectResults([{ id: 'user-1', mfaEnabled: true, passwordHash: null }]);
    mocks.verifyPasskeyReauthToken.mockResolvedValue({
      userId: 'user-1',
      challenge: 'challenge-123',
      action: 'delete-passkey',
    });

    const response = await mfaDisablePost(
      makeRequest('http://localhost/api/auth/mfa/disable', 'POST', {
        passkeyAssertion: { reauthToken: 'reauth-token', response: passkeyResponse },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTH_CHALLENGE_EXPIRED' });
    expect(mocks.verifyPasskeyAssertion).not.toHaveBeenCalled();
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it('accepts disable-mfa when the passkey reauth token action matches', async () => {
    queueSelectResults([{ id: 'user-1', mfaEnabled: true, passwordHash: null }]);
    mocks.verifyPasskeyReauthToken.mockResolvedValue({
      userId: 'user-1',
      challenge: 'challenge-123',
      action: 'disable-mfa',
    });
    mocks.verifyPasskeyAssertion.mockResolvedValue({ kind: 'ok' });

    const tx = {
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => []) })),
      })),
    };
    mocks.db.transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(tx));

    const response = await mfaDisablePost(
      makeRequest('http://localhost/api/auth/mfa/disable', 'POST', {
        passkeyAssertion: { reauthToken: 'reauth-token', response: passkeyResponse },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.verifyPasskeyAssertion).toHaveBeenCalledWith({
      userId: 'user-1',
      expectedChallenge: 'challenge-123',
      response: passkeyResponse,
    });
    expect(tx.delete).toHaveBeenCalledTimes(3);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('rejects recovery-code regeneration when a passkey reauth token was minted for another action', async () => {
    queueSelectResults([{ id: 'user-1', mfaEnabled: true, passwordHash: null }]);
    mocks.verifyPasskeyReauthToken.mockResolvedValue({
      userId: 'user-1',
      challenge: 'challenge-123',
      action: 'disable-mfa',
    });

    const response = await recoveryCodesPost(
      makeRequest('http://localhost/api/auth/mfa/recovery-codes', 'POST', {
        passkeyAssertion: { reauthToken: 'reauth-token', response: passkeyResponse },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTH_CHALLENGE_EXPIRED' });
    expect(mocks.verifyPasskeyAssertion).not.toHaveBeenCalled();
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it('rejects passkey deletion when a passkey reauth token was minted for another action', async () => {
    queueSelectResults(
      [{ id: 'user-1', passwordHash: null }],
      [{ id: 'passkey-1', userId: 'user-1' }],
      [{ c: 1 }],
      [{ c: 0 }],
    );
    mocks.verifyPasskeyReauthToken.mockResolvedValue({
      userId: 'user-1',
      challenge: 'challenge-123',
      action: 'disable-mfa',
    });

    const response = await deletePasskey(
      makeRequest('http://localhost/api/auth/passkeys/passkey-1', 'DELETE', {
        passkeyAssertion: { reauthToken: 'reauth-token', response: passkeyResponse },
      }),
      { params: Promise.resolve({ id: 'passkey-1' }) },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTH_CHALLENGE_EXPIRED' });
    expect(mocks.verifyPasskeyAssertion).not.toHaveBeenCalled();
    expect(mocks.db.delete).not.toHaveBeenCalled();
  });
});
