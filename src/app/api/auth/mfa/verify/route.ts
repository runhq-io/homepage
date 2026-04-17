import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import {
  verifyMfaPendingToken,
  createToken,
} from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import {
  verifyTotp,
  decryptSecret,
  verifyRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/mfa';

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

  let body: { mfaToken?: string; code?: string; isRecoveryCode?: boolean; returnToken?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }

  if (!body.mfaToken || !body.code) {
    return NextResponse.json({ error: 'mfaToken and code required' }, { status: 400, headers });
  }

  const claims = await verifyMfaPendingToken(body.mfaToken);
  if (!claims) {
    return NextResponse.json({ error: 'MFA_TOKEN_EXPIRED' }, { status: 401, headers });
  }
  if (!perUserLimiter.check(claims.userId)) return rateLimitResponse(headers);

  const [user] = await db.select().from(users).where(eq(users.id, claims.userId)).limit(1);
  if (!user || !user.mfaEnabled) {
    return NextResponse.json({ error: 'MFA_TOKEN_EXPIRED' }, { status: 401, headers });
  }

  let verified = false;
  let recoveryCodesRemaining: number | undefined;

  if (body.isRecoveryCode) {
    const normalized = normalizeRecoveryCode(body.code);
    const unused = await db.select().from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, claims.userId), isNull(userRecoveryCodes.usedAt)));
    for (const row of unused) {
      if (await verifyRecoveryCode(normalized, row.codeHash)) {
        await db.update(userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(eq(userRecoveryCodes.id, row.id));
        verified = true;
        recoveryCodesRemaining = unused.length - 1;
        break;
      }
    }
  } else {
    const [mfaRow] = await db.select().from(userMfa)
      .where(eq(userMfa.userId, claims.userId)).limit(1);
    if (mfaRow) {
      const secret = decryptSecret({
        ciphertext: mfaRow.secretEncrypted,
        iv: mfaRow.secretIv,
        authTag: mfaRow.secretAuthTag,
      });
      if (verifyTotp(secret, body.code)) {
        verified = true;
        await db.update(userMfa)
          .set({ lastUsedAt: new Date() })
          .where(eq(userMfa.id, mfaRow.id));
      }
    }
  }

  if (!verified) {
    return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers });
  }

  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, claims.userId));

  const sessionToken = await createToken(claims.userId);
  const userInfo = {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };

  if (body.returnToken) {
    return NextResponse.json(
      { token: sessionToken, user: userInfo, recoveryCodesRemaining },
      { headers },
    );
  }

  const response = NextResponse.json(
    { success: true, user: userInfo, recoveryCodesRemaining },
    { headers },
  );
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
