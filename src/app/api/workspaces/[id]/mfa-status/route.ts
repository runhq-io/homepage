import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, users, organizations, organizationMembers } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { enforceMfaOrRespond } from '@/lib/workspaceMfaEnforcement';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orgId } = await params;
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

  const [membership] = await db.select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403, headers: corsHeaders });
  }

  const [org] = await db.select({
    requireMfa: organizations.requireMfa,
    enforcedAt: organizations.requireMfaEnforcedAt,
  }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404, headers: corsHeaders });
  }

  const members = await db.select({
    userId: users.id,
    email: users.email,
    name: users.name,
    mfaEnabled: users.mfaEnabled,
  })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));

  const total = members.length;
  const withMfa = members.filter((m) => m.mfaEnabled).length;
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';
  const without = isAdmin
    ? members.filter((m) => !m.mfaEnabled).map(({ userId, email, name }) => ({ userId, email, name }))
    : undefined;

  return NextResponse.json({
    requireMfa: org.requireMfa,
    requireMfaEnforcedAt: org.enforcedAt,
    totalMembers: total,
    membersWithMfa: withMfa,
    membersWithout: without,
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
