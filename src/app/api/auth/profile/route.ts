import { NextResponse } from 'next/server';
import { getDb, users } from '@/db';
import { eq } from 'drizzle-orm';
import { extractUserIdFromToken } from '@/api/auth/jwt';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * PATCH /api/auth/profile
 *
 * Update user profile (username, name, avatar).
 */
export async function PATCH(request: Request) {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }

  const token = authHeader.slice(7);

  try {
    const userId = await extractUserIdFromToken(token);
    if (!userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
    }

    const body = await request.json() as { username?: string; name?: string; avatarUrl?: string };
    const updates: Record<string, any> = { updatedAt: new Date() };
    const db = getDb();

    if (typeof body.username === 'string') {
      const trimmed = body.username.trim();
      if (!USERNAME_REGEX.test(trimmed)) {
        return NextResponse.json({ error: 'Username must be 3-20 characters, letters, numbers, and underscores only' }, { status: 400, headers: corsHeaders });
      }
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, trimmed)).limit(1);
      if (existing && existing.id !== userId) {
        return NextResponse.json({ error: 'This username is already taken' }, { status: 409, headers: corsHeaders });
      }
      updates.username = trimmed;
    }

    if (typeof body.name === 'string') {
      const trimmed = body.name.trim();
      if (!trimmed || trimmed.length > 100) {
        return NextResponse.json({ error: 'Name must be 1-100 characters' }, { status: 400, headers: corsHeaders });
      }
      updates.name = trimmed;
    }

    if (typeof body.avatarUrl === 'string') {
      updates.avatarUrl = body.avatarUrl || null;
    }

    if (Object.keys(updates).length <= 1) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400, headers: corsHeaders });
    }

    await db.update(users).set(updates).where(eq(users.id, userId));

    const [user] = await db.select().from(users).where(eq(users.id, userId));

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
    }, { headers: corsHeaders });
  } catch (err) {
    console.error('[/api/auth/profile] Error:', err);
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500, headers: corsHeaders });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
