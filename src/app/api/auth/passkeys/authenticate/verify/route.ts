import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { db, users, userPasskeys } from '@/db';
import {
  verifyMfaPendingToken,
  verifyPasskeyAuthenticationToken,
  createToken,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { getRpConfig } from '@/lib/passkeys';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers: Record<string, string> = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.runhq.io') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!ipLimiter.check(ip)) return rateLimitResponse(headers);

  let body: {
    mfaToken?: string;
    authenticationToken?: string;
    response?: AuthenticationResponseJSON;
    returnToken?: boolean;
  };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }

  if (!body.mfaToken || !body.authenticationToken || !body.response) {
    return NextResponse.json({ error: 'mfaToken, authenticationToken, response required' }, { status: 400, headers });
  }

  const mfa = await verifyMfaPendingToken(body.mfaToken);
  if (!mfa) return NextResponse.json({ error: 'MFA_TOKEN_EXPIRED' }, { status: 401, headers });
  if (!perUserLimiter.check(mfa.userId)) return rateLimitResponse(headers);

  const authClaims = await verifyPasskeyAuthenticationToken(body.authenticationToken);
  if (!authClaims || authClaims.userId !== mfa.userId) {
    return NextResponse.json({ error: 'AUTH_CHALLENGE_EXPIRED' }, { status: 401, headers });
  }

  // Serialize concurrent verifies against the same credential via SELECT FOR
  // UPDATE. This prevents two parallel assertions from both passing clone
  // detection against a stale counter read — the classic "check-then-act"
  // race. Postgres row lock ensures the second verify waits until the first
  // commits its counter update, then sees the fresh value.
  const { rpID, expectedOrigin } = getRpConfig();

  const result = await db.transaction(async (tx) => {
    const [passkeyRow] = await tx.select().from(userPasskeys)
      .where(and(
        eq(userPasskeys.credentialId, body.response!.id),
        eq(userPasskeys.userId, mfa.userId),
        isNull(userPasskeys.disabledAt),
      ))
      .for('update')
      .limit(1);

    if (!passkeyRow) {
      return { kind: 'invalid' as const };
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response!,
        expectedChallenge: authClaims.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: passkeyRow.credentialId,
          publicKey: Buffer.from(passkeyRow.publicKey, 'base64url'),
          counter: passkeyRow.counter,
          transports: (passkeyRow.transports as AuthenticatorTransportFuture[]) || undefined,
        },
      });
    } catch {
      return { kind: 'invalid' as const };
    }

    if (!verification.verified) {
      return { kind: 'invalid' as const };
    }

    const newCounter = verification.authenticationInfo.newCounter;

    // Clone detection: now safe under the row lock. No stale reads.
    if (passkeyRow.counter > 0 && newCounter > 0 && newCounter <= passkeyRow.counter) {
      await tx.update(userPasskeys)
        .set({ disabledAt: new Date() })
        .where(eq(userPasskeys.id, passkeyRow.id));
      return { kind: 'clone' as const };
    }

    // Under the row lock the counter is guaranteed fresh, so a plain
    // assignment is correct — GREATEST is only needed when concurrent
    // writes can race, which they can't here.
    await tx.update(userPasskeys)
      .set({
        counter: newCounter,
        lastUsedAt: new Date(),
        backedUp: verification.authenticationInfo.credentialBackedUp,
      })
      .where(eq(userPasskeys.id, passkeyRow.id));

    return { kind: 'ok' as const };
  });

  if (result.kind === 'invalid') {
    return NextResponse.json({ error: 'INVALID_PASSKEY' }, { status: 401, headers });
  }
  if (result.kind === 'clone') {
    return NextResponse.json({ error: 'CREDENTIAL_CLONE_DETECTED' }, { status: 401, headers });
  }

  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, mfa.userId));

  const [user] = await db.select().from(users).where(eq(users.id, mfa.userId)).limit(1);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404, headers });

  const sessionToken = await createToken(mfa.userId);
  const userInfo = {
    id: user.id, email: user.email, username: user.username, name: user.name, avatarUrl: user.avatarUrl,
  };

  if (body.returnToken) {
    return NextResponse.json({ token: sessionToken, user: userInfo }, { headers });
  }

  const response = NextResponse.json({ success: true, user: userInfo }, { headers });
  response.cookies.set('auth_token', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return response;
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers: Record<string, string> = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.runhq.io') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }
  return new NextResponse(null, { status: 204, headers });
}
