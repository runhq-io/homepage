import { NextResponse } from 'next/server';
import { getDb, serverInviteLinks, servers, users } from '@/db';
import { eq } from 'drizzle-orm';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    const db = getDb();

    const [link] = await db
      .select({
        code: serverInviteLinks.code,
        expiresAt: serverInviteLinks.expiresAt,
        maxUses: serverInviteLinks.maxUses,
        uses: serverInviteLinks.uses,
        serverName: servers.name,
        createdByName: users.name,
      })
      .from(serverInviteLinks)
      .innerJoin(servers, eq(serverInviteLinks.serverId, servers.id))
      .innerJoin(users, eq(serverInviteLinks.createdById, users.id))
      .where(eq(serverInviteLinks.code, code))
      .limit(1);

    if (!link) {
      return NextResponse.json({ error: 'Invite link not found' }, { status: 404 });
    }

    const now = new Date();
    const expired = link.expiresAt <= now;
    const maxedOut = link.maxUses ? link.uses >= link.maxUses : false;
    const valid = !expired && !maxedOut;

    return NextResponse.json({
      invite: {
        code: link.code,
        serverName: link.serverName,
        creatorName: link.createdByName || 'Unknown',
        expiresAt: link.expiresAt.toISOString(),
        valid,
      },
    });
  } catch (error) {
    console.error('[Join] Get invite info error:', error);
    return NextResponse.json({ error: 'Failed to load invite' }, { status: 500 });
  }
}
