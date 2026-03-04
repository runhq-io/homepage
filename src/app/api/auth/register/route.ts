import { NextRequest, NextResponse } from 'next/server';
import { db, users, emailVerificationTokens } from '@/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '@/lib/password';
import { createToken } from '@/api/auth/jwt';
import { sendActivationEmail } from '@/lib/email';
import { randomBytes, createHash } from 'crypto';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiter: 5 registrations per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * POST /api/auth/register
 *
 * Creates a new account with username + email + password.
 * Sends a verification email before activating the account.
 * - For Console: sets HttpOnly cookie, returns { success: true, user }
 * - For web client (returnToken: true): returns { token, user, needsVerification }
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.fishtank.bot') || origin.endsWith('.tank.fish') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(headers);
  }

  let body: { email?: string; password?: string; username?: string; name?: string; returnToken?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const { email, password, username, name, returnToken } = body;

  if (!username?.trim()) {
    return NextResponse.json({ error: 'Username is required' }, { status: 400, headers });
  }
  if (!email?.trim()) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400, headers });
  }
  if (!password) {
    return NextResponse.json({ error: 'Password is required' }, { status: 400, headers });
  }

  const normalizedUsername = username.trim().toLowerCase();

  if (!USERNAME_REGEX.test(normalizedUsername)) {
    return NextResponse.json({
      error: 'Username must be 3-20 characters, letters, numbers, and underscores only',
    }, { status: 400, headers });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already exists
  const [existingEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingEmail) {
    return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409, headers });
  }

  // Check if username already exists
  const [existingUsername] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, normalizedUsername))
    .limit(1);

  if (existingUsername) {
    return NextResponse.json({ error: 'This username is already taken' }, { status: 409, headers });
  }

  const passwordHash = await hashPassword(password);

  const [newUser] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      username: normalizedUsername,
      name: name?.trim() || null,
      passwordHash,
      authProvider: 'email',
      lastLoginAt: new Date(),
    })
    .returning();

  // Generate email verification token
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  await db.insert(emailVerificationTokens).values({
    userId: newUser.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  });

  // Build verification URL
  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:8080';
  const clientOrigin = origin || 'http://localhost:5180';
  const verifyUrl = `${appUrl}/api/auth/verify-email?token=${rawToken}&redirect=${encodeURIComponent(clientOrigin)}`;

  try {
    await sendActivationEmail(normalizedEmail, verifyUrl);
  } catch (err) {
    console.error('[register] Failed to send verification email:', err);
  }

  const token = await createToken(newUser.id);
  const userInfo = {
    id: newUser.id,
    email: newUser.email,
    username: newUser.username,
    name: newUser.name,
    avatarUrl: newUser.avatarUrl,
  };

  if (returnToken) {
    return NextResponse.json({ token, user: userInfo, needsVerification: true }, { status: 201, headers });
  }

  const response = NextResponse.json({ success: true, user: userInfo, needsVerification: true }, { status: 201, headers });
  response.cookies.set('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  return response;
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = { ...corsHeaders };
  if (origin) {
    const isAllowed = origin.endsWith('.fishtank.bot') || origin.endsWith('.tank.fish') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }
  return new NextResponse(null, { status: 204, headers });
}
