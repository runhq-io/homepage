/**
 * Pure verify-options test for the widget JWT path.
 *
 * `authenticateWidget` runs `jose.jwtVerify(token, key, { algorithms: ['HS256'],
 * requiredClaims: ['exp'], maxTokenAge: WIDGET_JWT_MAX_TOKEN_AGE })`. The DB
 * layer adds nothing to the verify semantics — the security-relevant
 * behaviors are jose's. This test pins those behaviors so a later refactor
 * that drops `requiredClaims` or `maxTokenAge` is caught loudly.
 */

import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { WIDGET_JWT_MAX_TOKEN_AGE } from '../../lib/widgetSecretCrypto';

const SECRET = new TextEncoder().encode('a'.repeat(32));

const VERIFY_OPTIONS: jose.JWTVerifyOptions = {
  algorithms: ['HS256'],
  requiredClaims: ['exp'],
  maxTokenAge: WIDGET_JWT_MAX_TOKEN_AGE,
};

async function mintToken(opts: {
  setExp?: boolean;
  expSecondsFromNow?: number;
  iatSecondsAgo?: number;
}) {
  let builder = new jose.SignJWT({ type: 'widget_user', fp: 'fp_x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1');

  if (opts.iatSecondsAgo !== undefined) {
    builder = builder.setIssuedAt(Math.floor(Date.now() / 1000) - opts.iatSecondsAgo);
  } else {
    builder = builder.setIssuedAt();
  }

  if (opts.setExp) {
    builder = builder.setExpirationTime(
      Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 60),
    );
  }

  return await builder.sign(SECRET);
}

describe('widget JWT verify options', () => {
  it('accepts a fresh token with a valid exp', async () => {
    const token = await mintToken({ setExp: true, expSecondsFromNow: 60 });
    const { payload } = await jose.jwtVerify(token, SECRET, VERIFY_OPTIONS);
    expect(payload.sub).toBe('user-1');
  });

  it('rejects a token without exp (H4: requiredClaims enforces presence)', async () => {
    const token = await mintToken({ setExp: false });
    await expect(jose.jwtVerify(token, SECRET, VERIFY_OPTIONS)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await mintToken({ setExp: true, expSecondsFromNow: -10 });
    await expect(jose.jwtVerify(token, SECRET, VERIFY_OPTIONS)).rejects.toThrow();
  });

  it('rejects a token older than maxTokenAge even if exp is in the future', async () => {
    // iat 25h ago, exp 1h from now → token age > 24h cap.
    const token = await mintToken({
      setExp: true,
      expSecondsFromNow: 60 * 60,
      iatSecondsAgo: 25 * 60 * 60,
    });
    await expect(jose.jwtVerify(token, SECRET, VERIFY_OPTIONS)).rejects.toThrow();
  });

  it('rejects a token signed with a different key', async () => {
    const token = await mintToken({ setExp: true });
    const wrongKey = new TextEncoder().encode('b'.repeat(32));
    await expect(jose.jwtVerify(token, wrongKey, VERIFY_OPTIONS)).rejects.toThrow();
  });
});
