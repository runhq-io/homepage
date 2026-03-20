import { NextRequest, NextResponse } from 'next/server';
import { db, users, emailVerificationTokens } from '@/db';
import { eq } from 'drizzle-orm';
import { verifyPassword } from '@/lib/password';
import { sendActivationEmail } from '@/lib/email';
import { randomBytes, createHash } from 'crypto';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Strict rate limit: 3 resends per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * POST /api/auth/resend-verification
 *
 * Resends the email verification link. Requires valid email + password
 * to prevent abuse (only the account owner can request a resend).
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.runhq.io') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(headers);
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const { email, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (!user || !user.passwordHash) {
    // Don't reveal whether the account exists
    return NextResponse.json({ success: true }, { headers });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ success: true }, { headers });
  }

  // Already verified
  if (user.emailVerifiedAt) {
    return NextResponse.json({ success: true, alreadyVerified: true }, { headers });
  }

  // Generate new verification token
  const hasEmailService = !!process.env.RESEND_API_KEY;
  if (!hasEmailService) {
    // Auto-verify in dev
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
    return NextResponse.json({ success: true, alreadyVerified: true }, { headers });
  }

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  await db.insert(emailVerificationTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });

  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:8080';
  const clientOrigin = origin || 'http://localhost:5180';
  const verifyUrl = `${appUrl}/api/auth/verify-email?token=${rawToken}&redirect=${encodeURIComponent(clientOrigin)}`;

  try {
    await sendActivationEmail(normalizedEmail, verifyUrl);
  } catch (err) {
    console.error('[resend-verification] Failed to send email:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to send verification email: ${errMsg}` }, { status: 500, headers });
  }

  return NextResponse.json({ success: true }, { headers });
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.runhq.io') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }
  return new NextResponse(null, { status: 204, headers });
}
