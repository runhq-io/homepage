'use server';

import { db, agentTemplates } from '@/db';
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

export async function addAgentTemplate(formData: FormData): Promise<{ success: boolean; error?: string }> {
  await verifyAdmin();

  const name = formData.get('name') as string;
  const description = formData.get('description') as string;
  const systemPrompt = formData.get('systemPrompt') as string;
  const character = formData.get('character') as string;
  const model = formData.get('model') as string;
  const enabledToolsRaw = formData.get('enabledTools') as string;
  const startingCommand = formData.get('startingCommand') as string;
  const jobStartCommand = formData.get('jobStartCommand') as string;
  const autoStartTasks = formData.get('autoStartTasks') === 'true';
  const sortOrder = parseInt(formData.get('sortOrder') as string || '0', 10);

  if (!name) {
    return { success: false, error: 'Name is required' };
  }

  const enabledTools = enabledToolsRaw ? JSON.parse(enabledToolsRaw) : ['terminal', 'files'];

  await db.insert(agentTemplates).values({
    name,
    description: description || null,
    systemPrompt: systemPrompt || null,
    character: character || null,
    model: model || null,
    enabledTools,
    startingCommand: startingCommand || null,
    jobStartCommand: jobStartCommand || null,
    autoStartTasks,
    sortOrder: isNaN(sortOrder) ? 0 : sortOrder,
  });

  revalidatePath('/admin/agents');
  return { success: true };
}

export async function removeAgentTemplate(templateId: string): Promise<{ success: boolean }> {
  await verifyAdmin();

  await db.delete(agentTemplates).where(eq(agentTemplates.id, templateId));

  revalidatePath('/admin/agents');
  return { success: true };
}

export async function updateAgentTemplate(
  templateId: string,
  data: {
    name?: string; description?: string; systemPrompt?: string; character?: string;
    model?: string; enabledTools?: string[]; startingCommand?: string; jobStartCommand?: string;
    autoStartTasks?: boolean; sortOrder?: number;
  },
): Promise<{ success: boolean }> {
  await verifyAdmin();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description || null;
  if (data.systemPrompt !== undefined) updates.systemPrompt = data.systemPrompt || null;
  if (data.character !== undefined) updates.character = data.character || null;
  if (data.model !== undefined) updates.model = data.model || null;
  if (data.enabledTools !== undefined) updates.enabledTools = data.enabledTools;
  if (data.startingCommand !== undefined) updates.startingCommand = data.startingCommand || null;
  if (data.jobStartCommand !== undefined) updates.jobStartCommand = data.jobStartCommand || null;
  if (data.autoStartTasks !== undefined) updates.autoStartTasks = data.autoStartTasks;
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

  await db.update(agentTemplates).set(updates).where(eq(agentTemplates.id, templateId));

  revalidatePath('/admin/agents');
  return { success: true };
}
