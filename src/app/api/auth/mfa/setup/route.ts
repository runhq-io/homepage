import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, users, userMfa } from '@/db';
import { extractUserIdFromToken, createMfaSetupToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { generateTotpSecret, generateQrDataUrl } from '@/lib/mfa';

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

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }
  // Gate on TOTP specifically, not on the generic mfaEnabled flag — a user with
  // only passkeys (mfaEnabled=true, no userMfa row) is allowed to add TOTP as
  // an additional factor.
  const [existingTotp] = await db.select({ id: userMfa.id }).from(userMfa)
    .where(eq(userMfa.userId, userId)).limit(1);
  if (existingTotp) {
    return NextResponse.json({ error: 'TOTP_ALREADY_ENABLED' }, { status: 409, headers: corsHeaders });
  }
  if (!user.email) {
    return NextResponse.json({ error: 'Account has no email' }, { status: 400, headers: corsHeaders });
  }

  const secret = generateTotpSecret();
  const qrDataUrl = await generateQrDataUrl(secret, user.email);
  const setupToken = await createMfaSetupToken(userId, secret);

  return NextResponse.json({ secret, qrDataUrl, setupToken }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
