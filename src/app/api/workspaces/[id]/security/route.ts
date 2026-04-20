import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, organizations, organizationMembers } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { enforceMfaOrRespond } from '@/lib/workspaceMfaEnforcement';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function PATCH(
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
  if (!limiter.check(userId)) return rateLimitResponse(corsHeaders);

  const mfaGate = await enforceMfaOrRespond(userId, corsHeaders);
  if (mfaGate) return mfaGate;

  const [membership] = await db.select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403, headers: corsHeaders });
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return NextResponse.json({ error: 'Owner or admin role required' }, { status: 403, headers: corsHeaders });
  }

  let body: { requireMfa?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }); }

  if (typeof body.requireMfa !== 'boolean') {
    return NextResponse.json({ error: 'requireMfa: boolean required' }, { status: 400, headers: corsHeaders });
  }

  const [existing] = await db.select({
    requireMfa: organizations.requireMfa,
    enforcedAt: organizations.requireMfaEnforcedAt,
  }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!existing) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404, headers: corsHeaders });
  }

  const patch: Record<string, unknown> = {
    requireMfa: body.requireMfa,
    updatedAt: new Date(),
  };
  if (body.requireMfa && !existing.requireMfa) {
    patch.requireMfaEnforcedAt = new Date();
  }
  if (!body.requireMfa) {
    patch.requireMfaEnforcedAt = null;
  }

  await db.update(organizations).set(patch).where(eq(organizations.id, orgId));

  return NextResponse.json({
    requireMfa: body.requireMfa,
    requireMfaEnforcedAt: patch.requireMfaEnforcedAt ?? null,
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
