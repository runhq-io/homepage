import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, servers } from '@/db';
import { extractUserIdFromToken } from '@/api/auth/jwt';
import { rateLimit, rateLimitResponse } from '@/lib/rateLimit';
import { enforceMfaOrRespond } from '@/lib/workspaceMfaEnforcement';
import { checkServerPermission } from '@/api/services/ServerService';

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
  const { id: serverId } = await params;
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

  // Toggling a server-wide security policy is owner-only. Servers currently
  // only have 'owner' | 'member' — no dedicated admin role — so we gate on
  // ownership explicitly rather than using canEditServer (which also lets
  // members edit).
  const isOwner = await checkServerPermission(serverId, userId, ['owner']);
  if (!isOwner) {
    return NextResponse.json({ error: 'Owner role required' }, { status: 403, headers: corsHeaders });
  }

  let body: { requireMfa?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }); }

  if (typeof body.requireMfa !== 'boolean') {
    return NextResponse.json({ error: 'requireMfa: boolean required' }, { status: 400, headers: corsHeaders });
  }

  const [existing] = await db.select({
    requireMfa: servers.requireMfa,
    enforcedAt: servers.requireMfaEnforcedAt,
  }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!existing) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404, headers: corsHeaders });
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

  await db.update(servers).set(patch).where(eq(servers.id, serverId));

  return NextResponse.json({
    requireMfa: body.requireMfa,
    requireMfaEnforcedAt: patch.requireMfaEnforcedAt ?? null,
  }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
