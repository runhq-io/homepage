import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, users, userMfa, userRecoveryCodes } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { verifyPassword } from '@/lib/password';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { verifyTotp, decryptSecret } from '@/lib/mfa';

const perUserLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

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

  let body: { password?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }
  if (!body.password || !body.code) {
    return NextResponse.json({ error: 'password and code required' }, { status: 400, headers: corsHeaders });
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }
  if (!user.mfaEnabled) {
    return NextResponse.json({ error: 'MFA_NOT_ENABLED' }, { status: 409, headers: corsHeaders });
  }
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Account has no password' }, { status: 400, headers: corsHeaders });
  }
  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    return NextResponse.json({ error: 'INVALID_PASSWORD' }, { status: 401, headers: corsHeaders });
  }

  const [mfaRow] = await db.select().from(userMfa)
    .where(eq(userMfa.userId, userId)).limit(1);
  if (!mfaRow) {
    return NextResponse.json({ error: 'MFA_NOT_ENABLED' }, { status: 409, headers: corsHeaders });
  }
  const secret = decryptSecret({
    ciphertext: mfaRow.secretEncrypted,
    iv: mfaRow.secretIv,
    authTag: mfaRow.secretAuthTag,
  });
  if (!verifyTotp(secret, body.code)) {
    return NextResponse.json({ error: 'INVALID_MFA_CODE' }, { status: 401, headers: corsHeaders });
  }

  await db.transaction(async (tx) => {
    await tx.delete(userMfa).where(eq(userMfa.userId, userId));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.update(users)
      .set({ mfaEnabled: false, mfaEnabledAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  });

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
