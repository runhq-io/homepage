import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db, agentTasks } from '@/db';
import { eq, and, lt } from 'drizzle-orm';

// POST /api/tasks/cancel-stale - Cancel all "running" tasks older than 1 hour
export async function POST() {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Cancel tasks that have been "running" for more than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await db
    .update(agentTasks)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      error: 'Cancelled: Task was stale (running > 1 hour)'
    })
    .where(
      and(
        eq(agentTasks.status, 'running'),
        lt(agentTasks.startedAt, oneHourAgo)
      )
    )
    .returning({ id: agentTasks.id });

  return NextResponse.json({
    message: `Cancelled ${result.length} stale tasks`,
    cancelledIds: result.map(r => r.id)
  });
}
