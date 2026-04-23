'use server';

import { db, subscriptions, inviteCodes, type PlanId } from '@/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { applyAdjustment } from '@/api/services/UsageAdjustments';
import { getPeriodSpending } from '@/api/services/UsageService';

async function requireAdmin() {
  const session = await auth();
  if (!(session?.user as any)?.isAdmin) {
    throw new Error('Unauthorized: Admin access required');
  }
  return session!;
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

/**
 * Grant bonus credits to a user.
 *
 * `cents` is a positive number of cents to add to the user's balance.
 * Recorded as a negative adjustment (refund/grant) in usage_adjustments
 * so the full credit history is auditable.
 */
export async function addBonusCredits(userId: string, cents: number) {
  try {
    const session = await requireAdmin();
    const adminUserId = session.user.id;

    await applyAdjustment({
      userId,
      adminUserId,
      amountCents: -cents, // negative = credit grant (balance increases)
      reason: `Admin bonus credit grant of ${cents} cents`,
    });

    revalidatePath(`/admin/users/${userId}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to add bonus credits:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Reset the current billing-period spend to zero by applying a negative
 * adjustment equal to the period's current total cost.
 *
 * Usage events are immutable historical records — they are never deleted or
 * mutated. Instead, this inserts a compensating adjustment into usage_adjustments
 * so that getPeriodSpending returns ~0 for the current period, while retaining
 * a complete audit trail of both the original spend and the admin reset.
 *
 * If period spending is already $0, this is a no-op.
 */
export async function resetMonthlyUsage(userId: string) {
  try {
    const session = await requireAdmin();
    const adminUserId = session.user.id;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const spending = await getPeriodSpending(userId, periodStart, periodEnd);

    if (spending.totalCostCents === 0) {
      // Already at zero — nothing to do
      revalidatePath(`/admin/users/${userId}`);
      return { success: true };
    }

    // Insert a compensating negative adjustment to offset the current period spend
    await applyAdjustment({
      userId,
      adminUserId,
      amountCents: -spending.totalCostCents, // negative offsets the positive spend
      reason: `Admin reset of monthly usage (period ${periodStart.toISOString().slice(0, 7)})`,
    });

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
