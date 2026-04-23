import { db, subscriptions, usageAdjustments } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { getOrCreateSubscription } from './UsageService';

export interface ApplyAdjustmentInput {
  userId: string;
  adminUserId: string;
  amountCents: number;   // signed: positive = charge more, negative = refund/credit grant
  reason: string;
}

/**
 * Apply an admin-initiated balance adjustment.
 *
 * Positive amountCents = additional charge (balance decreases).
 * Negative amountCents = refund or credit grant (balance increases).
 *
 * The adjustment is persisted to usage_adjustments and the balance is updated
 * in the same transaction.
 */
export async function applyAdjustment(input: ApplyAdjustmentInput): Promise<void> {
  const { userId, adminUserId, amountCents, reason } = input;
  if (!reason.trim()) throw new Error('applyAdjustment: reason is required');

  // Ensure a subscription row exists — otherwise UPDATE would silently no-op
  // for users who haven't made any Claude calls yet (e.g., admin grants to
  // brand-new users). getOrCreateSubscription creates with default balance 0.
  await getOrCreateSubscription(userId);

  await db.transaction(async (tx) => {
    // Balance is numeric(12,4) — preserve sub-cent precision, no rounding.
    await tx
      .update(subscriptions)
      .set({
        creditBalanceCents: sql`GREATEST(0, ${subscriptions.creditBalanceCents} - ${amountCents.toFixed(4)}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, userId));

    await tx.insert(usageAdjustments).values({
      userId,
      adminUserId,
      amountCents: amountCents.toFixed(4),
      reason,
    });
  });
}
