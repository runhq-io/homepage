import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, users, servers, serverMembers } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { enforceMfaOrRespond } from '@/lib/workspaceMfaEnforcement';
import { canAccessServer, checkServerPermission } from '@/api/services/ServerService';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: serverId } = await params;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'No token provided' }, { status: 401, headers: corsHeaders });
  }
  const userId = await extractUserIdFromToken(authHeader.slice(7));
  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  const mfaGate = await enforceMfaOrRespond(userId, corsHeaders);
  if (mfaGate) return mfaGate;

  const isMember = await canAccessServer(serverId, userId);
  if (!isMember) {
    return NextResponse.json({ error: 'Not a member of this server' }, { status: 403, headers: corsHeaders });
  }

  const [server] = await db.select({
    requireMfa: servers.requireMfa,
    enforcedAt: servers.requireMfaEnforcedAt,
  }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404, headers: corsHeaders });
  }

  const members = await db.select({
    userId: users.id,
    email: users.email,
    name: users.name,
    mfaEnabled: users.mfaEnabled,
  })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(eq(serverMembers.serverId, serverId));

  const total = members.length;
  const withMfa = members.filter((m) => m.mfaEnabled).length;
  // Only the owner sees who is missing MFA (privacy + scope of action).
  const isOwner = await checkServerPermission(serverId, userId, ['owner']);
  const without = isOwner
    ? members.filter((m) => !m.mfaEnabled).map(({ userId, email, name }) => ({ userId, email, name }))
    : undefined;

  return NextResponse.json({
    requireMfa: server.requireMfa,
    requireMfaEnforcedAt: server.enforcedAt,
    totalMembers: total,
    membersWithMfa: withMfa,
    membersWithout: without,
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
