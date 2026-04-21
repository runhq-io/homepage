'use server';

import { db, servers } from '@/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { destroyFlyMachine } from '@/lib/fly-api';
import { deleteServersAndDependents } from '@/api/services/ServerService';

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

  await deleteServersAndDependents(ids);

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

      const matchingServers = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.machineId, machine.id));

      if (matchingServers.length > 0) {
        await deleteServersAndDependents(matchingServers.map((s) => s.id));
      }

      destroyed++;
    } catch (error) {
      errors.push(`fly/${machine.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  revalidatePath('/admin/servers');
  return { success: errors.length === 0, destroyed, errors };
}
