'use server';

import { db, users, adminUsers, subscriptions, usageEvents, usageAdjustments, payments, inviteCodes, userAgents, conversations, messages, agentTasks, servers, deviceCodes } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { revokeAllUserOAuthTokens } from '@/lib/oauth';
import { deleteServersAndDependents } from '@/api/services/ServerService';

// Verify the current user is an admin.
//
// IMPORTANT: Admin access is controlled centrally by NextAuth via the admin_users table.
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

export async function toggleUserActivation(userId: string): Promise<{ success: boolean; isActivated: boolean }> {
  await verifyAdmin();

  // Get current status
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new Error('User not found');
  }

  const newStatus = !user.isActivated;

  await db.update(users).set({
    isActivated: newStatus,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  revalidatePath('/admin/users');
  return { success: true, isActivated: newStatus };
}

export async function deleteUser(userId: string): Promise<{ success: boolean }> {
  await verifyAdmin();

  // Verify the user exists
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new Error('User not found');
  }

  // Delete all related records (child tables first)
  // 1. Messages (via conversations)
  const userConversations = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, userId));
  if (userConversations.length > 0) {
    const conversationIds = userConversations.map((c) => c.id);
    await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
  }

  // Collect this user's server IDs up front so we can fully clean them up
  // (members, invites, tasks, etc.) via the centralized helper. A bare
  // `delete from servers where owner_id = ?` would fail on FK constraints
  // for any server that has child rows.
  const userServers = await db.select({ id: servers.id }).from(servers).where(eq(servers.ownerId, userId));
  const userServerIds = userServers.map((s) => s.id);

  // 2. Tables without inter-dependencies + payments (must precede subscriptions)
  await Promise.all([
    db.delete(agentTasks).where(eq(agentTasks.userId, userId)),
    db.delete(conversations).where(eq(conversations.userId, userId)),
    db.delete(userAgents).where(eq(userAgents.userId, userId)),
    db.delete(adminUsers).where(eq(adminUsers.userId, userId)),
    db.delete(usageEvents).where(eq(usageEvents.userId, userId)),
    db.delete(usageAdjustments).where(eq(usageAdjustments.userId, userId)),
    db.delete(payments).where(eq(payments.userId, userId)),
    db.delete(inviteCodes).where(eq(inviteCodes.createdByUserId, userId)),
    deleteServersAndDependents(userServerIds),
    db.delete(deviceCodes).where(eq(deviceCodes.userId, userId)),
    revokeAllUserOAuthTokens(userId),
  ]);

  // 3. Subscriptions (after payments which reference them)
  await db.delete(subscriptions).where(eq(subscriptions.userId, userId));

  // 4. Delete the user
  await db.delete(users).where(eq(users.id, userId));

  revalidatePath('/admin/users');
  return { success: true };
}

