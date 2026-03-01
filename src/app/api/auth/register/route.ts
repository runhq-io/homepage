import { NextRequest, NextResponse } from 'next/server';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '@/lib/password';
import { createToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiter: 5 registrations per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

/**
 * POST /api/auth/register
 *
 * Creates a new account with email + password.
 * - For Console: sets HttpOnly cookie, returns { success: true, user }
 * - For web client (returnToken: true): returns { token, user }
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

  let body: { email?: string; password?: string; name?: string; returnToken?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }

  const { email, password, name, returnToken } = body;

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400, headers });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409, headers });
  }

  const passwordHash = await hashPassword(password);

  const [newUser] = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      name: name?.trim() || null,
      passwordHash,
      authProvider: 'email',
      lastLoginAt: new Date(),
    })
    .returning();

  const token = await createToken(newUser.id);
  const userInfo = {
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    avatarUrl: newUser.avatarUrl,
  };

  if (returnToken) {
    return NextResponse.json({ token, user: userInfo }, { status: 201, headers });
  }

  const response = NextResponse.json({ success: true, user: userInfo }, { status: 201, headers });
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
