'use server';

import { db, servers, serverMembers, serverInvites, serverInviteLinks, publicPorts } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { destroyFlyMachine } from '@/lib/fly-api';

async function verifyAdmin(): Promise<void> {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.email) {
    throw new Error('Not authenticated');
  }

  if (!user?.isAdmin) {
    throw new Error('Not authorized');
  }
}

export async function deleteServers(ids: string[]): Promise<{ success: boolean; count: number }> {
  await verifyAdmin();

  if (ids.length === 0) {
    return { success: true, count: 0 };
  }

  // Delete child records first (no ON DELETE CASCADE on these FKs)
  await db.delete(serverMembers).where(inArray(serverMembers.serverId, ids));
  await db.delete(serverInvites).where(inArray(serverInvites.serverId, ids));
  await db.delete(serverInviteLinks).where(inArray(serverInviteLinks.serverId, ids));
  await db.delete(publicPorts).where(inArray(publicPorts.serverId, ids));
  await db.delete(servers).where(inArray(servers.id, ids));

  revalidatePath('/admin/servers');
  return { success: true, count: ids.length };
}

export async function destroyMachines(
  machines: { id: string; provider: 'fly' }[]
): Promise<{ success: boolean; destroyed: number; errors: string[] }> {
  await verifyAdmin();

  if (machines.length === 0) {
    return { success: true, destroyed: 0, errors: [] };
  }

  let destroyed = 0;
  const errors: string[] = [];

  for (const machine of machines) {
    try {
      await destroyFlyMachine(machine.id);

      // Clean up matching DB records if they exist
      const matchingServers = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.machineId, machine.id));

      if (matchingServers.length > 0) {
        const ids = matchingServers.map((s: { id: string }) => s.id);
        await db.delete(serverMembers).where(inArray(serverMembers.serverId, ids));
        await db.delete(serverInvites).where(inArray(serverInvites.serverId, ids));
        await db.delete(serverInviteLinks).where(inArray(serverInviteLinks.serverId, ids));
        await db.delete(publicPorts).where(inArray(publicPorts.serverId, ids));
        await db.delete(servers).where(inArray(servers.id, ids));
      }

      destroyed++;
    } catch (error) {
      errors.push(`fly/${machine.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  revalidatePath('/admin/servers');
  return { success: errors.length === 0, destroyed, errors };
}
