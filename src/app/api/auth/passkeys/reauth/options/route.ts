import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { db, userPasskeys } from '@/db';
import {
  extractUserIdFromToken,
  createPasskeyReauthToken,
  type PasskeyReauthAction,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { getRpConfig } from '@/lib/passkeys';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }
  if (!perUserLimiter.check(userId)) return rateLimitResponse(corsHeaders);

  let body: { action?: string };
  try {
    body = request.headers.get('content-type')?.includes('application/json')
      ? await request.json()
      : {};
  } catch { body = {}; }

  const actionRaw = body.action;
  if (actionRaw !== 'disable-mfa' && actionRaw !== 'regenerate-codes' && actionRaw !== 'delete-passkey') {
    return NextResponse.json(
      { error: 'action must be one of: disable-mfa, regenerate-codes, delete-passkey' },
      { status: 400, headers: corsHeaders },
    );
  }
  const action: PasskeyReauthAction = actionRaw;

  const active = await db.select({
    credentialId: userPasskeys.credentialId,
    transports: userPasskeys.transports,
  })
    .from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)));

  if (active.length === 0) {
    return NextResponse.json({ error: 'NO_PASSKEYS' }, { status: 404, headers: corsHeaders });
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

  const reauthToken = await createPasskeyReauthToken(userId, options.challenge, action);
  return NextResponse.json({ options, reauthToken }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
