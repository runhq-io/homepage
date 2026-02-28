'use server';

import { db, serverTemplates, servers } from '@/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';

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

export async function addTemplate(formData: FormData): Promise<{ success: boolean; error?: string }> {
  await verifyAdmin();

  const serverId = formData.get('serverId') as string;
  const name = formData.get('name') as string;
  const description = formData.get('description') as string;
  const iconUrl = formData.get('iconUrl') as string;
  const sortOrder = parseInt(formData.get('sortOrder') as string || '0', 10);

  if (!serverId || !name) {
    return { success: false, error: 'Server ID and name are required' };
  }

  // Verify server exists
  const [server] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) {
    return { success: false, error: `Server ${serverId} not found` };
  }

  await db.insert(serverTemplates).values({
    serverId,
    name,
    description: description || null,
    iconUrl: iconUrl || null,
    sortOrder: isNaN(sortOrder) ? 0 : sortOrder,
  });

  revalidatePath('/admin/templates');
  return { success: true };
}

export async function removeTemplate(templateId: string): Promise<{ success: boolean }> {
  await verifyAdmin();

  await db.delete(serverTemplates).where(eq(serverTemplates.id, templateId));

  revalidatePath('/admin/templates');
  return { success: true };
}

export async function updateTemplate(
  templateId: string,
  data: { name?: string; description?: string; iconUrl?: string; sortOrder?: number },
): Promise<{ success: boolean }> {
  await verifyAdmin();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description || null;
  if (data.iconUrl !== undefined) updates.iconUrl = data.iconUrl || null;
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

  await db.update(serverTemplates).set(updates).where(eq(serverTemplates.id, templateId));

  revalidatePath('/admin/templates');
  return { success: true };
}
