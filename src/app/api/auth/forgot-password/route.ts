import { NextRequest, NextResponse } from 'next/server';
import { db, users, passwordResetTokens } from '@/db';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { sendPasswordResetEmail } from '@/lib/email';
import { randomBytes, createHash } from 'crypto';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiters
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }); // 5 per 15 min per IP
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3 }); // 3 per 15 min per email

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * POST /api/auth/forgot-password
 *
 * Sends a password reset email if the email exists.
 * Always returns 200 to prevent email enumeration.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // Rate limit by IP
  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(corsHeaders);
  }

  let body: { email?: string; redirect?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const { email, redirect } = body;
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: corsHeaders });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit by email
  if (!emailLimiter.check(normalizedEmail)) {
    return rateLimitResponse(corsHeaders);
  }

  // Always return success to prevent email enumeration
  const successResponse = () =>
    NextResponse.json(
      { message: 'If an account with that email exists, a password reset link has been sent.' },
      { headers: corsHeaders }
    );

  // Look up user
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (!user) {
    return successResponse();
  }

  // Invalidate any existing unused tokens for this user
  // (by checking for unused tokens — we don't delete, just let them expire)

  // Generate a cryptographically secure token
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Store hashed token in DB (expires in 1 hour)
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
  });

  // Build reset URL
  const baseUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:8080';
  const redirectParam = redirect ? `&redirect=${encodeURIComponent(redirect)}` : '';
  const resetUrl = `${baseUrl}/reset-password?token=${rawToken}${redirectParam}`;

  try {
    await sendPasswordResetEmail(normalizedEmail, resetUrl);
  } catch (err) {
    console.error('[forgot-password] Failed to send email:', err);
    // Still return success to prevent enumeration
  }

  return successResponse();
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
