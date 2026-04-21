import { NextRequest, NextResponse } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, users, userRecoveryCodes, userMfa, userPasskeys } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
};

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  const [user] = await db.select({
    mfaEnabled: users.mfaEnabled, mfaEnabledAt: users.mfaEnabledAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }

  const unused = await db.select({ id: userRecoveryCodes.id })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));

  const [totpRow] = await db.select({ id: userMfa.id }).from(userMfa)
    .where(eq(userMfa.userId, userId)).limit(1);

  const passkeys = await db.select({
    id: userPasskeys.id,
    nickname: userPasskeys.nickname,
    deviceType: userPasskeys.deviceType,
    backedUp: userPasskeys.backedUp,
    transports: userPasskeys.transports,
    lastUsedAt: userPasskeys.lastUsedAt,
    createdAt: userPasskeys.createdAt,
    disabledAt: userPasskeys.disabledAt,
  })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));

  return NextResponse.json({
    mfaEnabled: user.mfaEnabled,
    mfaEnabledAt: user.mfaEnabledAt,
    recoveryCodesRemaining: unused.length,
    hasTotp: !!totpRow,
    passkeys,
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
