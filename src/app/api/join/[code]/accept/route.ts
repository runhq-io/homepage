import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getDb, serverInviteLinks, serverMembers } from '@/db';
import { eq, and, sql } from 'drizzle-orm';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const session = await auth();
    const userId = (session?.user as any)?.id;

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { code } = await params;
    const db = getDb();

    const [link] = await db
      .select({
        id: serverInviteLinks.id,
        serverId: serverInviteLinks.serverId,
        expiresAt: serverInviteLinks.expiresAt,
        maxUses: serverInviteLinks.maxUses,
        uses: serverInviteLinks.uses,
        createdById: serverInviteLinks.createdById,
      })
      .from(serverInviteLinks)
      .where(eq(serverInviteLinks.code, code))
      .limit(1);

    if (!link) {
      return NextResponse.json({ error: 'Invite link not found' }, { status: 404 });
    }

    const now = new Date();
    if (link.expiresAt <= now) {
      return NextResponse.json({ error: 'This invite link has expired' }, { status: 400 });
    }
    if (link.maxUses && link.uses >= link.maxUses) {
      return NextResponse.json({ error: 'This invite link has reached its maximum uses' }, { status: 400 });
    }

    // Check if already a member
    const [existing] = await db
      .select({ id: serverMembers.id })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, link.serverId), eq(serverMembers.userId, userId)))
      .limit(1);

    if (existing) {
      return NextResponse.json({ success: true, serverId: link.serverId });
    }

    // Add as member
    await db.insert(serverMembers).values({
      serverId: link.serverId,
      userId,
      role: 'member',
      invitedById: link.createdById,
    });

    // Increment uses
    await db
      .update(serverInviteLinks)
      .set({ uses: sql`${serverInviteLinks.uses} + 1` })
      .where(eq(serverInviteLinks.id, link.id));

    return NextResponse.json({ success: true, serverId: link.serverId });
  } catch (error) {
    console.error('[Join] Accept invite error:', error);
    return NextResponse.json({ error: 'Failed to accept invite' }, { status: 500 });
  }
}
