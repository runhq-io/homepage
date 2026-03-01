import { NextRequest, NextResponse } from 'next/server';
import { db, users, passwordResetTokens } from '@/db';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { hashPassword } from '@/lib/password';
import { createHash } from 'crypto';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiter: 10 attempts per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * POST /api/auth/reset-password
 *
 * Validates the reset token and sets a new password.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(corsHeaders);
  }

  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const { token, password } = body;

  if (!token || !password) {
    return NextResponse.json({ error: 'Token and password are required' }, { status: 400, headers: corsHeaders });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers: corsHeaders });
  }

  // Hash the provided token and look it up
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const [resetToken] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        gt(passwordResetTokens.expiresAt, new Date()),
        isNull(passwordResetTokens.usedAt)
      )
    )
    .limit(1);

  if (!resetToken) {
    return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400, headers: corsHeaders });
  }

  // Hash the new password and update the user
  const newPasswordHash = await hashPassword(password);

  await db.update(users).set({
    passwordHash: newPasswordHash,
    authProvider: 'email',
    updatedAt: new Date(),
  }).where(eq(users.id, resetToken.userId));

  // Mark the token as used
  await db.update(passwordResetTokens).set({
    usedAt: new Date(),
  }).where(eq(passwordResetTokens.id, resetToken.id));

  return NextResponse.json({ message: 'Password has been reset. You can now sign in.' }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
