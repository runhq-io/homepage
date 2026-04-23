import { db, subscriptions, usageAdjustments } from '@/db';
import { eq, sql } from 'drizzle-orm';

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
  const wholeAmount = Math.round(amountCents);

  await db.transaction(async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        creditBalanceCents: sql`GREATEST(0, ${subscriptions.creditBalanceCents} - ${wholeAmount})`,
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
