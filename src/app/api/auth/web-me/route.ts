import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { users } from '@/db';
import { eq } from 'drizzle-orm';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { isAdmin } from '@/lib/adminPolicy';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * GET /api/auth/web-me
 *
 * Validates a Bearer token (JWT or legacy base64) and returns user info.
 */
export async function GET(request: Request) {
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

    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, userId));

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401, headers: corsHeaders });
    }

    const userIsAdmin = await isAdmin(user.id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isAdmin: userIsAdmin,
        approved: !!user.isActivated,
      },
    }, { headers: corsHeaders });
  } catch (err) {
    console.error('[web-me] Token validation error:', err);
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
