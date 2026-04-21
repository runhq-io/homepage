import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { db, users, userPasskeys } from '@/db';
import { extractUserIdFromToken, verifyPasskeyRegistrationToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { getRpConfig, defaultNickname } from '@/lib/passkeys';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

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

  let body: { registrationToken?: string; response?: RegistrationResponseJSON };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }); }

  if (!body.registrationToken || !body.response) {
    return NextResponse.json({ error: 'registrationToken and response required' }, { status: 400, headers: corsHeaders });
  }

  const claims = await verifyPasskeyRegistrationToken(body.registrationToken);
  if (!claims || claims.userId !== userId) {
    return NextResponse.json({ error: 'REGISTRATION_EXPIRED' }, { status: 401, headers: corsHeaders });
  }

  const { rpID, expectedOrigin } = getRpConfig();

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: claims.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 400, headers: corsHeaders });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: 'INVALID_PASSKEY' }, { status: 401, headers: corsHeaders });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const credentialId = credential.id;
  const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');
  const counter = credential.counter;
  const transports = body.response.response.transports || [];

  const userAgent = request.headers.get('user-agent');
  const nickname = defaultNickname(transports, credentialDeviceType, userAgent);

  try {
    const [inserted] = await db.insert(userPasskeys).values({
      userId,
      credentialId,
      publicKey: publicKeyB64,
      counter,
      transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname,
    }).returning({ id: userPasskeys.id, nickname: userPasskeys.nickname });

    // Flip mfa_enabled if it wasn't already true.
    await db.update(users)
      .set({ mfaEnabled: true, mfaEnabledAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));

    return NextResponse.json({ id: inserted.id, nickname: inserted.nickname }, { headers: corsHeaders });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('user_passkeys_credential_id') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'DUPLICATE_CREDENTIAL' }, { status: 409, headers: corsHeaders });
    }
    throw e;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
