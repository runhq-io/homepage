'use server';

import { db, users, adminUsers, subscriptions, usageRecords, payments, inviteCodes, userAgents, conversations, messages, agentTasks, servers, deviceCodes } from '@/db';
import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { revokeAllUserOAuthTokens } from '@/lib/oauth';

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

  // 2. Tables without inter-dependencies + payments (must precede subscriptions)
  await Promise.all([
    db.delete(agentTasks).where(eq(agentTasks.userId, userId)),
    db.delete(conversations).where(eq(conversations.userId, userId)),
    db.delete(userAgents).where(eq(userAgents.userId, userId)),
    db.delete(adminUsers).where(eq(adminUsers.userId, userId)),
    db.delete(usageRecords).where(eq(usageRecords.userId, userId)),
    db.delete(payments).where(eq(payments.userId, userId)),
    db.delete(inviteCodes).where(eq(inviteCodes.createdByUserId, userId)),
    db.delete(servers).where(eq(servers.ownerId, userId)),
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

