import { NextRequest, NextResponse } from 'next/server';
import { getDb, users } from '@/db';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '@/lib/password';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';

// Rate limiter: 10 attempts per 15 min per IP
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * POST /api/auth/change-password
 *
 * Changes the user's password. Requires Bearer token authentication.
 *
 * - If the user already has a password: currentPassword is required.
 * - If the user signed up via OAuth and has no password: currentPassword can be omitted
 *   to set their first password.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  if (!ipLimiter.check(ip)) {
    return rateLimitResponse(corsHeaders);
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }

  const token = authHeader.slice(7);
  const userId = await extractUserIdFromToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const { currentPassword, newPassword } = body;

  if (!newPassword) {
    return NextResponse.json({ error: 'New password is required' }, { status: 400, headers: corsHeaders });
  }

  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers: corsHeaders });
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404, headers: corsHeaders });
  }

  // If the user has an existing password, verify it before allowing change
  if (user.passwordHash) {
    if (!currentPassword) {
      return NextResponse.json({ error: 'Current password is required' }, { status: 400, headers: corsHeaders });
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401, headers: corsHeaders });
    }
  }

  const newHash = await hashPassword(newPassword);

  await db.update(users).set({
    passwordHash: newHash,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  return NextResponse.json({ message: 'Password updated successfully' }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
