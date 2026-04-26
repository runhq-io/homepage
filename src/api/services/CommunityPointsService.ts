/**
 * CommunityPointsService
 *
 * Transactional core of the community-points awarding pipeline.
 *
 * Responsibilities:
 *  - Award points for ticket completion (auto_completion)
 *  - Grant/deduct bonus points by staff (admin_grant)
 *  - Reverse a prior grant (reversal)
 *
 * Every operation is:
 *  1. Idempotent — ON CONFLICT (idempotency_key) DO NOTHING is the source of truth.
 *  2. Atomic — grant insert + balance upsert + notification insert + rank recomputation
 *     all happen in a single DB transaction.
 *  3. Non-blocking for consumers — pubsub publish happens AFTER the transaction commits.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import {
  widgetUsers,
  widgetUserBalances,
  widgetUserNotifications,
  pointGrants,
  type PointGrant,
  type WidgetUserBalance,
} from '../../db/schema';
import {
  isPayoutEligible,
  computePayoutAmount,
  autoCompletionIdempotencyKey,
  adminGrantIdempotencyKey,
  reversalIdempotencyKey,
  type StatusChangeEvent,
} from './communityAwardingPolicy';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface PointsServiceDeps {
  /** Drizzle db instance (or a mock-compatible substitute for unit tests). */
  db: NodePgDatabase<typeof schema>;
  /** Pubsub publish function — called post-commit, never inside the transaction. */
  publish: (topic: string, payload: unknown) => void;
  /** Injectable clock; defaults to `() => new Date()`. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface AwardResult {
  applied: boolean;
  amount?: number;
  grantId?: string;
}

export interface GrantBonusResult {
  grant: PointGrant;
  newBalance: WidgetUserBalance;
}

export interface ReverseGrantResult {
  reversal: PointGrant;
}

// ---------------------------------------------------------------------------
// CommunityPointsService
// ---------------------------------------------------------------------------

export class CommunityPointsService {
  private readonly db: NodePgDatabase<typeof schema>;
  private readonly publish: (topic: string, payload: unknown) => void;
  private readonly now: () => Date;

  constructor(deps: PointsServiceDeps) {
    this.db = deps.db;
    this.publish = deps.publish;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // 1. awardForCompletion
  // -------------------------------------------------------------------------

  /**
   * Awards points to a widget user when their ticket reaches a terminal-success
   * status. Idempotent on ticketId.
   */
  async awardForCompletion(event: StatusChangeEvent): Promise<AwardResult> {
    if (!isPayoutEligible(event)) {
      return { applied: false };
    }

    // Resolve widgetUserId from (projectId, externalUserId)
    const [widgetUser] = await this.db
      .select({ id: widgetUsers.id })
      .from(widgetUsers)
      .where(
        and(
          eq(widgetUsers.projectId, event.projectId),
          eq(widgetUsers.externalUserId, event.externalUserId!),
        ),
      )
      .limit(1);

    if (!widgetUser) {
      return { applied: false };
    }

    const widgetUserId = widgetUser.id;
    const amount = computePayoutAmount(event);
    const idempotencyKey = autoCompletionIdempotencyKey(event.ticketId);
    const now = this.now();

    // Capture pre-transaction state for pubsub payload
    let oldBalance = 0;
    let oldRank: number | null = null;
    let newBalance = 0;
    let newRank: number | null = null;
    let grantId: string | null = null;
    let notificationId: string | null = null;

    await this.db.transaction(async (tx) => {
      // Idempotent insert — ON CONFLICT DO NOTHING
      const [inserted] = await tx
        .insert(pointGrants)
        .values({
          projectId: event.projectId,
          widgetUserId,
          amount,
          source: 'auto_completion',
          idempotencyKey,
          ticketId: event.ticketId,
          metadata: {
            upvoteCountAtTransition: event.upvoteCountAtTransition,
            selfUpvoted: event.selfUpvoted,
          },
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();

      // If the row already existed, do nothing (already applied).
      if (!inserted) {
        return;
      }

      grantId = inserted.id;

      // Read existing balance for pubsub delta
      const [existingBalance] = await tx
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, widgetUserId));

      oldBalance = existingBalance?.balance ?? 0;
      oldRank = existingBalance?.rank ?? null;

      // Upsert balance: insert if missing, update if present.
      const [updatedBalance] = await tx
        .insert(widgetUserBalances)
        .values({
          widgetUserId,
          projectId: event.projectId,
          balance: amount,
          payoutsCount: 1,
          lastPayoutAt: now,
          rank: null,
        })
        .onConflictDoUpdate({
          target: widgetUserBalances.widgetUserId,
          set: {
            balance: sql`${widgetUserBalances.balance} + ${amount}`,
            payoutsCount: sql`${widgetUserBalances.payoutsCount} + 1`,
            lastPayoutAt: now,
          },
        })
        .returning();

      newBalance = updatedBalance!.balance;

      // Recompute ranks for the entire project
      await recomputeProjectRanks(tx, event.projectId);

      // Re-read rank after recomputation
      const [reranked] = await tx
        .select({ rank: widgetUserBalances.rank })
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, widgetUserId));
      newRank = reranked?.rank ?? null;

      // Insert notification
      const [notif] = await tx
        .insert(widgetUserNotifications)
        .values({
          widgetUserId,
          projectId: event.projectId,
          type: 'points.awarded',
          payload: {
            grantId: inserted.id,
            amount,
            ticketId: event.ticketId,
            oldBalance,
            newBalance,
            oldRank,
            newRank,
          },
        })
        .returning({ id: widgetUserNotifications.id });
      notificationId = notif!.id;
    });

    // If grantId is null the insert conflicted — already applied.
    if (grantId === null) {
      return { applied: false };
    }

    // Post-commit pubsub — never inside the transaction.
    this.publish(`community:${event.projectId}`, {
      type: 'balance_changed',
      widgetUserId,
      oldBalance,
      newBalance,
      oldRank,
      newRank,
      grantId,
    });
    this.publish(`community:widget_user:${widgetUserId}`, {
      type: 'notification',
      notificationId,
    });

    return { applied: true, amount, grantId };
  }

  // -------------------------------------------------------------------------
  // 2. grantBonus
  // -------------------------------------------------------------------------

  /**
   * Grants (or deducts) points via staff action. Idempotent on clientRequestId.
   */
  async grantBonus(args: {
    projectId: string;
    widgetUserId: string;
    amount: number;
    reason: string;
    reasonCode?: string;
    grantedByUserId?: string;
    clientRequestId: string;
  }): Promise<GrantBonusResult> {
    const idempotencyKey = adminGrantIdempotencyKey(args.clientRequestId);
    const now = this.now();

    let grant: PointGrant | null = null;
    let newBalance: WidgetUserBalance | null = null;
    let isIdempotentHit = false;

    let oldBalance = 0;
    let oldRank: number | null = null;
    let newBalanceValue = 0;
    let newRank: number | null = null;

    await this.db.transaction(async (tx) => {
      // Idempotent insert
      const [inserted] = await tx
        .insert(pointGrants)
        .values({
          projectId: args.projectId,
          widgetUserId: args.widgetUserId,
          amount: args.amount,
          source: 'admin_grant',
          idempotencyKey,
          reason: args.reason,
          reasonCode: args.reasonCode ?? null,
          grantedByUserId: args.grantedByUserId ?? null,
          metadata: {},
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        // Idempotency hit — fetch existing grant and current balance
        isIdempotentHit = true;
        const [existing] = await tx
          .select()
          .from(pointGrants)
          .where(eq(pointGrants.idempotencyKey, idempotencyKey));
        grant = existing!;

        const [currentBalance] = await tx
          .select()
          .from(widgetUserBalances)
          .where(eq(widgetUserBalances.widgetUserId, args.widgetUserId));
        newBalance = currentBalance!;
        return;
      }

      grant = inserted;

      // Read existing balance for pubsub delta
      const [existingBalance] = await tx
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, args.widgetUserId));

      oldBalance = existingBalance?.balance ?? 0;
      oldRank = existingBalance?.rank ?? null;

      // Upsert balance — bonus does NOT bump payoutsCount or lastPayoutAt
      const [updatedBalance] = await tx
        .insert(widgetUserBalances)
        .values({
          widgetUserId: args.widgetUserId,
          projectId: args.projectId,
          balance: args.amount,
          payoutsCount: 0,
          lastPayoutAt: null,
          rank: null,
        })
        .onConflictDoUpdate({
          target: widgetUserBalances.widgetUserId,
          set: {
            balance: sql`${widgetUserBalances.balance} + ${args.amount}`,
          },
        })
        .returning();

      newBalanceValue = updatedBalance!.balance;
      newBalance = updatedBalance!;

      // Recompute ranks
      await recomputeProjectRanks(tx, args.projectId);

      // Re-read balance after rank recomputation
      const [reranked] = await tx
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, args.widgetUserId));
      newBalance = reranked!;
      newRank = reranked?.rank ?? null;

      // Insert points.bonus notification
      await tx.insert(widgetUserNotifications).values({
        widgetUserId: args.widgetUserId,
        projectId: args.projectId,
        type: 'points.bonus',
        payload: {
          grantId: inserted.id,
          amount: args.amount,
          reason: args.reason,
          reasonCode: args.reasonCode,
          oldBalance,
          newBalance: newBalanceValue,
          oldRank,
          newRank,
        },
      });
    });

    // Post-commit pubsub — only on fresh insert
    if (!isIdempotentHit) {
      this.publish(`community:${args.projectId}`, {
        type: 'balance_changed',
        widgetUserId: args.widgetUserId,
        oldBalance,
        newBalance: newBalanceValue,
        oldRank,
        newRank,
        grantId: grant!.id,
      });
      this.publish(`community:widget_user:${args.widgetUserId}`, {
        type: 'notification',
      });
    }

    return { grant: grant!, newBalance: newBalance! };
  }

  // -------------------------------------------------------------------------
  // 3. reverseGrant
  // -------------------------------------------------------------------------

  /**
   * Reverses a prior grant by inserting a negating row. Idempotent on clientRequestId.
   * Reversals do not create user-facing notifications (they are admin-internal).
   */
  async reverseGrant(args: {
    projectId: string;
    grantId: string;
    reason: string;
    grantedByUserId?: string;
    clientRequestId: string;
  }): Promise<ReverseGrantResult> {
    // Load the original grant (outside transaction — read-only lookup)
    const [original] = await this.db
      .select()
      .from(pointGrants)
      .where(eq(pointGrants.id, args.grantId));

    if (!original) {
      throw new Error('Grant not found');
    }

    if (original.source === 'reversal') {
      throw new Error('Cannot reverse a reversal grant');
    }

    const idempotencyKey = reversalIdempotencyKey(args.grantId);
    const now = this.now();

    let reversal: PointGrant | null = null;
    let isIdempotentHit = false;

    let oldBalance = 0;
    let oldRank: number | null = null;
    let newBalance = 0;
    let newRank: number | null = null;

    await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(pointGrants)
        .values({
          projectId: args.projectId,
          widgetUserId: original.widgetUserId,
          amount: -original.amount,
          source: 'reversal',
          idempotencyKey,
          reversesGrantId: args.grantId,
          reason: args.reason,
          grantedByUserId: args.grantedByUserId ?? null,
          metadata: {},
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        // Idempotency hit — fetch existing reversal row
        isIdempotentHit = true;
        const [existing] = await tx
          .select()
          .from(pointGrants)
          .where(eq(pointGrants.idempotencyKey, idempotencyKey));
        reversal = existing!;
        return;
      }

      reversal = inserted;

      // Read existing balance for pubsub delta
      const [existingBalance] = await tx
        .select()
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, original.widgetUserId));

      oldBalance = existingBalance?.balance ?? 0;
      oldRank = existingBalance?.rank ?? null;

      // Apply negative delta — reversal does NOT touch payoutsCount or lastPayoutAt
      const [updatedBalance] = await tx
        .insert(widgetUserBalances)
        .values({
          widgetUserId: original.widgetUserId,
          projectId: args.projectId,
          balance: -original.amount,
          payoutsCount: 0,
          lastPayoutAt: null,
          rank: null,
        })
        .onConflictDoUpdate({
          target: widgetUserBalances.widgetUserId,
          set: {
            balance: sql`${widgetUserBalances.balance} + ${-original.amount}`,
          },
        })
        .returning();

      newBalance = updatedBalance!.balance;

      // Recompute ranks
      await recomputeProjectRanks(tx, args.projectId);

      // Re-read rank after recomputation
      const [reranked] = await tx
        .select({ rank: widgetUserBalances.rank })
        .from(widgetUserBalances)
        .where(eq(widgetUserBalances.widgetUserId, original.widgetUserId));
      newRank = reranked?.rank ?? null;

      // No notification for reversals — they are admin-internal.
    });

    // Post-commit pubsub — balance_changed only (no per-user notification topic)
    if (!isIdempotentHit) {
      this.publish(`community:${args.projectId}`, {
        type: 'balance_changed',
        widgetUserId: original.widgetUserId,
        oldBalance,
        newBalance,
        oldRank,
        newRank,
        grantId: reversal!.id,
        reversesGrantId: args.grantId,
      });
    }

    return { reversal: reversal! };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recomputes ranks for all users in a project based on:
 *   1. balance DESC
 *   2. payouts_count DESC
 *   3. last_payout_at DESC NULLS LAST
 *   4. widget_users.created_at ASC (earliest member wins tiebreak)
 *   5. widget_user_id ASC (deterministic final tiebreak)
 *
 * Runs inside the caller's transaction via the `tx` parameter.
 */
async function recomputeProjectRanks(
  tx: Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0],
  projectId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH ranked AS (
      SELECT b.widget_user_id,
             ROW_NUMBER() OVER (
               PARTITION BY b.project_id
               ORDER BY b.balance DESC,
                        b.payouts_count DESC,
                        b.last_payout_at DESC NULLS LAST,
                        u.created_at ASC,
                        b.widget_user_id ASC
             ) AS new_rank
      FROM widget_user_balances b
      JOIN widget_users u ON u.id = b.widget_user_id
      WHERE b.project_id = ${projectId}
    )
    UPDATE widget_user_balances AS b
    SET rank = ranked.new_rank
    FROM ranked
    WHERE b.widget_user_id = ranked.widget_user_id
  `);
}
