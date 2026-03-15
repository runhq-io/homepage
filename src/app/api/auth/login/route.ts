import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { verifyPassword } from '@/lib/password';
import { createToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiters for brute-force prevention
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 }); // 15 attempts per 15 min per IP
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }); // 5 attempts per 15 min per email

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * POST /api/auth/login
 *
 * Authenticates with email + password.
 * - For Console (same-origin): sets HttpOnly cookie, returns { success: true, user }
 * - For web client (cross-origin, returnToken: true): returns { token, user } in JSON body
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

  let body: { email?: string; password?: string; returnToken?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const { email, password, returnToken } = body;

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers });
  }

  if (!emailLimiter.check(email.toLowerCase().trim())) {
    return rateLimitResponse(headers);
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401, headers });
  }

  if (!user.passwordHash) {
    return NextResponse.json(
      { error: 'This account was created with Google. Use "Forgot password" to set a password.' },
      { status: 401, headers },
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401, headers });
  }

  // Block unverified email accounts
  if (user.authProvider === 'email' && !user.emailVerifiedAt) {
    return NextResponse.json(
      { error: 'Please verify your email before signing in. Check your inbox for the verification link.' },
      { status: 403, headers },
    );
  }

  // Update last login
  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));

  const token = await createToken(user.id);
  const userInfo = {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };

  // Web client needs the token in the response body (cross-origin, can't set cookies)
  if (returnToken) {
    return NextResponse.json({ token, user: userInfo }, { headers });
  }

  // Console: set HttpOnly cookie
  const response = NextResponse.json({ success: true, user: userInfo }, { headers });
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
    const isAllowed = origin.endsWith('.runhq.io') ||
      origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    headers['Access-Control-Allow-Origin'] = isAllowed ? origin : '';
  }
  return new NextResponse(null, { status: 204, headers });
}
