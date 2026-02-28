'use server';

import { db, subscriptions, usageRecords, inviteCodes, type PlanId } from '@/db';
import { eq, and, gte, lte } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';

async function requireAdmin() {
  const session = await auth();
  if (!(session?.user as any)?.isAdmin) {
    throw new Error('Unauthorized: Admin access required');
  }
  return session;
}

export async function updateUserPlan(userId: string, planId: string) {
  try {
    await requireAdmin();

    // Check if user has a subscription
    const existing = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      // Update existing subscription
      await db
        .update(subscriptions)
        .set({
          planId: planId as PlanId,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, userId));
    } else {
      // Create new subscription
      await db.insert(subscriptions).values({
        userId,
        planId: planId as PlanId,
        status: 'active',
      });
    }

    revalidatePath(`/admin/users/${userId}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to update user plan:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function addBonusCredits(userId: string, cents: number) {
  try {
    await requireAdmin();

    // Check if user has a subscription
    const existing = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      // Add to existing balance
      const currentBalance = existing[0].creditBalanceCents || 0;
      await db
        .update(subscriptions)
        .set({
          creditBalanceCents: currentBalance + cents,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.userId, userId));
    } else {
      // Create subscription with bonus credits
      await db.insert(subscriptions).values({
        userId,
        planId: 'free', // Default to free plan
        status: 'active',
        creditBalanceCents: cents,
      });
    }

    revalidatePath(`/admin/users/${userId}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to add bonus credits:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function resetMonthlyUsage(userId: string) {
  try {
    await requireAdmin();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    // Reset current period usage to 0
    await db
      .update(usageRecords)
      .set({
        inputTokens: 0,
        outputTokens: 0,
        totalCostCents: 0,
        requestCount: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(usageRecords.userId, userId),
          gte(usageRecords.periodStart, startOfMonth),
          lte(usageRecords.periodEnd, endOfMonth)
        )
      );

    revalidatePath(`/admin/users/${userId}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to reset monthly usage:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Generate a random 8-character alphanumeric code (excludes ambiguous chars like 0, O, l, 1, I)
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function generateInviteCode(userId: string) {
  try {
    await requireAdmin();

    // Generate unique code
    let code = generateCode();
    let attempts = 0;
    while (attempts < 10) {
      const [existing] = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).limit(1);
      if (!existing) break;
      code = generateCode();
      attempts++;
    }

    // Create the invite code (belongs to this user)
    await db.insert(inviteCodes).values({
      code,
      createdByUserId: userId,
    });

    revalidatePath(`/admin/users/${userId}`);
    return { success: true, code };
  } catch (error) {
    console.error('Failed to generate invite code:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
