import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { db, userPasskeys } from '@/db';
import {
  verifyMfaPendingToken,
  createPasskeyAuthenticationToken,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { getRpConfig } from '@/lib/passkeys';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

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

  let body: { mfaToken?: string };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }

  if (!body.mfaToken) {
    return NextResponse.json({ error: 'mfaToken required' }, { status: 400, headers });
  }

  const claims = await verifyMfaPendingToken(body.mfaToken);
  if (!claims) {
    return NextResponse.json({ error: 'MFA_TOKEN_EXPIRED' }, { status: 401, headers });
  }
  if (!perUserLimiter.check(claims.userId)) return rateLimitResponse(headers);

  const active = await db.select({
    credentialId: userPasskeys.credentialId,
    transports: userPasskeys.transports,
  })
    .from(userPasskeys)
    .where(and(eq(userPasskeys.userId, claims.userId), isNull(userPasskeys.disabledAt)));

  if (active.length === 0) {
    return NextResponse.json({ error: 'NO_PASSKEYS' }, { status: 404, headers });
  }

  const { rpID } = getRpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: active.map((c) => ({
      id: c.credentialId,
      transports: (c.transports as AuthenticatorTransportFuture[]) || undefined,
    })),
  });

  const authenticationToken = await createPasskeyAuthenticationToken(claims.userId, options.challenge);
  return NextResponse.json({ options, authenticationToken }, { headers });
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
