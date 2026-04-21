import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, userPasskeys } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
};

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  const rows = await db.select({
    id: userPasskeys.id,
    nickname: userPasskeys.nickname,
    deviceType: userPasskeys.deviceType,
    backedUp: userPasskeys.backedUp,
    transports: userPasskeys.transports,
    lastUsedAt: userPasskeys.lastUsedAt,
    createdAt: userPasskeys.createdAt,
    disabledAt: userPasskeys.disabledAt,
  })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));

  return NextResponse.json({ passkeys: rows }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
