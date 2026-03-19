import { NextRequest, NextResponse } from 'next/server';
import { db, users, emailVerificationTokens } from '@/db';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiter: 10 attempts per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

/**
 * GET /api/auth/verify-email?token=xxx
 *
 * Verifies a user's email address using the token sent during registration.
 * Redirects to the client login page with a success/error message.
 */
export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!ipLimiter.check(ip)) {
    return rateLimitResponse();
  }

  const token = request.nextUrl.searchParams.get('token');
  const redirect = request.nextUrl.searchParams.get('redirect');

  if (!token) {
    return redirectWithMessage(redirect, 'error', 'Missing verification token');
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  // Find a valid, unused token that hasn't expired
  const [verificationToken] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, new Date()),
      )
    )
    .limit(1);

  if (!verificationToken) {
    // Token may have been consumed by an email client link prefetch.
    // Check if this token exists and the user's email is already verified.
    const [usedToken] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, tokenHash))
      .limit(1);

    if (usedToken) {
      const [user] = await db
        .select({ emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(eq(users.id, usedToken.userId))
        .limit(1);

      if (user?.emailVerifiedAt) {
        return redirectWithMessage(redirect, 'success', 'Email verified! You can now sign in.');
      }
    }

    return redirectWithMessage(redirect, 'error', 'Invalid or expired verification link');
  }

  // Mark token as used
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(emailVerificationTokens.id, verificationToken.id));

  // Verify the user's email
  await db
    .update(users)
    .set({
      emailVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, verificationToken.userId));

  return redirectWithMessage(redirect, 'success', 'Email verified! You can now sign in.');
}

function redirectWithMessage(redirect: string | null, status: string, message: string) {
  const baseUrl = redirect || process.env.APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:5180';
  const url = new URL('/login', baseUrl);
  url.searchParams.set('verified', status);
  url.searchParams.set('message', message);
  return NextResponse.redirect(url.toString());
}
