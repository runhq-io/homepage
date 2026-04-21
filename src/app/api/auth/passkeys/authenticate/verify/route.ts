import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db, users } from '@/db';
import {
  verifyMfaPendingToken,
  verifyPasskeyAuthenticationToken,
  createToken,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { verifyPasskeyAssertion } from '@/lib/passkeyVerify';

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

  const result = await verifyPasskeyAssertion({
    userId: mfa.userId,
    expectedChallenge: authClaims.challenge,
    response: body.response,
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
