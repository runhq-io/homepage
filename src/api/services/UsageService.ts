/**
 * Credit-Based Usage Tracking Service
 *
 * Users have a credit balance (in cents/dollars).
 * Each AI request costs a certain amount which is deducted from their balance.
 * Users can buy credits through Stripe.
 */

import { eq, and, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  users,
  subscriptions,
  usageEvents,
  usageAdjustments,
  plans,
  adminUsers,
  type PlanId,
  type Subscription,
  type Plan,
} from '../../db/schema';
import type { TokenCounts } from './pricing';

// ============================================================================
// Types
// ============================================================================

export interface CreditBalance {
  balanceCents: number;  // Current balance in cents
  balanceDollars: number; // Current balance in dollars (for display)
  plan: PlanId;
  hasPaymentMethod: boolean;
  // Period stats
  periodSpentCents: number;
  periodRequestCount: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface CreditCheckResult {
  allowed: boolean;
  reason?: 'insufficient_credits' | 'past_due' | 'no_subscription';
  balanceCents: number;
  plan: PlanId;
  hasPaymentMethod: boolean;
  periodEnd: Date;
}

export interface UsageTrackResult {
  costCents: number;
  newBalanceCents: number;
}

// ============================================================================
// Default Plan Configuration (credit-based)
// ============================================================================

export const PLAN_CONFIG: Record<PlanId, {
  id: PlanId;
  name: string;
  description: string;
  monthlyPriceCents: number;
  monthlyCreditsCents: number;  // Credits given each month
  maxConcurrentAgents: number;
  maxServers: number;            // Max servers a user can own
  signupBonusCents: number;     // One-time bonus for first subscription
  features: string[];
  isActive: boolean;
}> = {
  free: {
    id: 'free',
    name: 'Free',
    description: 'Get started for free',
    monthlyPriceCents: 0,
    monthlyCreditsCents: 500,    // $5 free credits
    maxConcurrentAgents: 1,
    maxServers: 1,
    signupBonusCents: 0,
    features: ['$5 monthly credits', '1 concurrent worker', '1 server'],
    isActive: true,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    description: 'For individuals',
    monthlyPriceCents: 2000,    // $20/month
    monthlyCreditsCents: 2500,  // $25 in credits
    maxConcurrentAgents: 3,
    maxServers: 3,
    signupBonusCents: 500,      // $5 signup bonus
    features: ['$25 monthly credits', '3 concurrent workers', '3 servers', '$5 signup bonus'],
    isActive: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For power users',
    monthlyPriceCents: 10000,   // $100/month
    monthlyCreditsCents: 12500, // $125 in credits
    maxConcurrentAgents: 5,
    maxServers: 10,
    signupBonusCents: 1000,     // $10 signup bonus
    features: ['$125 monthly credits', '5 concurrent workers', '10 servers', '$10 signup bonus'],
    isActive: true,
  },
  team: {
    id: 'team',
    name: 'Team',
    description: 'For teams',
    monthlyPriceCents: 23900,   // $239/month
    monthlyCreditsCents: 30000, // $300 in credits
    maxConcurrentAgents: 10,
    maxServers: 25,
    signupBonusCents: 2500,     // $25 signup bonus
    features: ['$300 monthly credits', '10 concurrent workers', '25 servers', '$25 signup bonus', 'Priority support'],
    isActive: false,
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

function getBillingPeriod(date: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractUserIdFromToken(token: string): string | null {
  let userId: string | null = null;

  try {
    // Check if it's a JWT (format: header.payload.signature)
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      userId = payload.userId || null;
    } else {
      // Try base64-encoded JSON: { userId, exp }
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      userId = decoded.userId || null;
    }
  } catch {
    // Fallback: check if the token itself is a UUID
    if (UUID_REGEX.test(token)) {
      return token;
    }
  }

  // All DB userId columns are UUID — reject non-UUID values
  if (userId && !UUID_REGEX.test(userId)) {
    console.warn(`[UsageService] Extracted userId "${userId}" is not a valid UUID, ignoring`);
    return null;
  }

  return userId;
}

function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

// ============================================================================
// Subscription Management
// ============================================================================

/**
 * Get or create a subscription for a user (defaults to 'free' tier)
 */
export async function getOrCreateSubscription(userId: string): Promise<Subscription> {
  // Check for existing subscription
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });

  if (existing) {
    return existing;
  }

  // Create default 'free' subscription with initial credits
  const { start, end } = getBillingPeriod();
  const planConfig = PLAN_CONFIG.free;

  const [newSub] = await db.insert(subscriptions).values({
    userId,
    planId: 'free',
    status: 'active',
    // numeric column: Drizzle expects a string at write time.
    creditBalanceCents: planConfig.monthlyCreditsCents.toFixed(4),
    currentPeriodStart: start,
    currentPeriodEnd: end,
  }).returning();

  console.log(`[UsageService] Created subscription for user ${userId} with $${centsToDollars(planConfig.monthlyCreditsCents)} credits`);
  return newSub;
}

/**
 * Get subscription by user ID
 */
export async function getSubscriptionByUserId(userId: string): Promise<Subscription | null> {
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });
  return sub || null;
}

/**
 * Update subscription plan (for upgrades/downgrades)
 */
export async function updateSubscriptionPlan(
  userId: string,
  newPlanId: PlanId,
  stripeSubscriptionId?: string,
  stripeCustomerId?: string
): Promise<Subscription> {
  const existing = await getOrCreateSubscription(userId);
  const planConfig = PLAN_CONFIG[newPlanId];

  // Check if this is first paid upgrade (signup bonus)
  // Note: signupBonusUsed is not stored in DB, so we grant bonus on first upgrade from free
  const grantSignupBonus = existing.planId === 'free' &&
    newPlanId !== 'free' &&
    planConfig.signupBonusCents > 0;

  // Add monthly credits + signup bonus to balance.
  // creditBalanceCents comes back from Drizzle as a string (numeric column) — cast first.
  const creditsToAdd = planConfig.monthlyCreditsCents + (grantSignupBonus ? planConfig.signupBonusCents : 0);
  const newBalance = Number(existing.creditBalanceCents ?? 0) + creditsToAdd;

  const [updated] = await db.update(subscriptions)
    .set({
      planId: newPlanId,
      stripeSubscriptionId: stripeSubscriptionId || existing.stripeSubscriptionId,
      stripeCustomerId: stripeCustomerId || existing.stripeCustomerId,
      // numeric column: pass as string.
      creditBalanceCents: newBalance.toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId))
    .returning();

  console.log(`[UsageService] Updated subscription for user ${userId}: ${existing.planId} → ${newPlanId}`);
  console.log(`[UsageService] Added $${centsToDollars(creditsToAdd)} credits, new balance: $${centsToDollars(newBalance)}`);

  return updated;
}

// ============================================================================
// Usage Tracking
// ============================================================================

export interface TrackUsageContext {
  serverId: string | null;
  taskId: string | null;
  taskLabel: string | null;
  jobId: string | null;
  channelId: string | null;
  channelLabel: string | null;
  agentId: string | null;
  agentLabel: string | null;
  conversationId: string | null;
}

export interface TrackUsageInput {
  userId: string;
  model: string;
  tokens: TokenCounts;
  costCents: number;               // computed by caller using pricing.calculateCost
  context: TrackUsageContext;
  anthropicRequestId: string | null;
}

/**
 * Persist one Claude-call event and deduct the cost from the user's balance.
 * Both operations happen in one DB transaction — either both succeed or neither.
 *
 * Balance is clamped at 0 (existing behavior; debt is not tracked).
 */
export async function trackUsage(input: TrackUsageInput): Promise<void> {
  const { userId, model, tokens, costCents, context, anthropicRequestId } = input;

  await db.transaction(async (tx) => {
    // Deduct balance atomically using SQL GREATEST(0, balance - cost).
    // Cost preserved at sub-cent precision via numeric(12,4) column — no rounding.
    await tx
      .update(subscriptions)
      .set({
        creditBalanceCents: sql`GREATEST(0, ${subscriptions.creditBalanceCents} - ${costCents.toFixed(4)}::numeric)`,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, userId));

    // Insert the event with full precision cost.
    await tx.insert(usageEvents).values({
      userId,
      serverId: context.serverId,
      ts: new Date(),
      model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
      costCents: costCents.toFixed(4),  // numeric column expects string
      taskId: context.taskId,
      taskLabel: context.taskLabel,
      jobId: context.jobId,
      channelId: context.channelId,
      channelLabel: context.channelLabel,
      agentId: context.agentId,
      agentLabel: context.agentLabel,
      conversationId: context.conversationId,
      anthropicRequestId,
    });
  });
}


/**
 * Track task execution (for analytics)
 */
export async function trackTask(
  userToken: string,
  taskId: string,
  agentId: string
): Promise<void> {
  const userId = extractUserIdFromToken(userToken);
  console.log(`[UsageService] Task started: user=${userId}, task=${taskId}, agent=${agentId}`);
}

// ============================================================================
// Credit Balance Queries
// ============================================================================

/**
 * Get credit balance for a user
 */
export async function getCreditBalance(userToken: string): Promise<CreditBalance> {
  console.log(`[UsageService] getCreditBalance called with token: ${userToken.substring(0, 30)}...`);

  const userId = extractUserIdFromToken(userToken);
  if (!userId) {
    throw new Error('Invalid token');
  }

  console.log(`[UsageService] getCreditBalance for userId: ${userId}`);

  const subscription = await getOrCreateSubscription(userId);
  const period = getBillingPeriod();
  const spending = await getPeriodSpending(userId, period.start, period.end);

  console.log(`[UsageService] getCreditBalance - periodSpentCents: ${spending.totalCostCents}, requestCount: ${spending.requestCount}`);

  // Drizzle returns numeric as a string — cast once at the boundary.
  const balanceCents = Number(subscription.creditBalanceCents ?? 0);
  return {
    balanceCents,
    balanceDollars: centsToDollars(balanceCents),
    plan: subscription.planId as PlanId,
    hasPaymentMethod: !!subscription.stripeCustomerId,
    periodSpentCents: spending.totalCostCents,
    periodRequestCount: spending.requestCount,
    periodStart: period.start,
    periodEnd: period.end,
  };
}


/**
 * Check if user has enough credits
 */
export async function checkCreditBalance(userToken: string): Promise<CreditCheckResult> {
  const userId = extractUserIdFromToken(userToken);
  if (!userId) {
    const { end } = getBillingPeriod();
    return {
      allowed: false,
      reason: 'no_subscription',
      balanceCents: 0,
      plan: 'free',
      hasPaymentMethod: false,
      periodEnd: end,
    };
  }

  const subscription = await getOrCreateSubscription(userId);
  const hasPaymentMethod = !!subscription.stripeCustomerId;
  const periodEnd = subscription.currentPeriodEnd;

  // Drizzle returns numeric as a string — cast once at the boundary.
  const balance = Number(subscription.creditBalanceCents ?? 0);

  if (subscription.status === 'past_due') {
    return {
      allowed: false,
      reason: 'past_due',
      balanceCents: balance,
      plan: subscription.planId as PlanId,
      hasPaymentMethod,
      periodEnd,
    };
  }

  // Need at least 1 cent to make a request
  if (balance < 1) {
    return {
      allowed: false,
      reason: 'insufficient_credits',
      balanceCents: balance,
      plan: subscription.planId as PlanId,
      hasPaymentMethod,
      periodEnd,
    };
  }

  return {
    allowed: true,
    balanceCents: balance,
    plan: subscription.planId as PlanId,
    hasPaymentMethod,
    periodEnd,
  };
}


export interface UsageHistoryRow {
  period: string;        // 'YYYY-MM'
  inputTokens: number;
  outputTokens: number;
  totalCostCents: number;
  requestCount: number;
}

/**
 * Get usage history grouped by calendar month for a time period.
 * Replaces the old usage_records-based getUsageRecords.
 */
export async function getUsageHistory(
  userId: string,
  start: Date,
  end: Date,
): Promise<UsageHistoryRow[]> {
  return db
    .select({
      period:         sql<string>`to_char(date_trunc('month', ${usageEvents.ts}), 'YYYY-MM')`,
      inputTokens:    sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
      outputTokens:   sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      gte(usageEvents.ts, start),
      lte(usageEvents.ts, end),
    ))
    .groupBy(sql`date_trunc('month', ${usageEvents.ts})`)
    .orderBy(sql`date_trunc('month', ${usageEvents.ts})`);
}

// ============================================================================
// Plan Management
// ============================================================================

/**
 * Seed plans into the database (run on startup)
 */
export async function seedPlans(): Promise<void> {
  // Seed/update plans
  for (const [id, config] of Object.entries(PLAN_CONFIG)) {
    const planId = id as PlanId;
    const existing = await db.query.plans.findFirst({
      where: eq(plans.id, planId),
    });

    if (!existing) {
      await db.insert(plans).values({
        id: planId,
        name: config.name,
        description: config.description,
        monthlyPriceCents: config.monthlyPriceCents,
        monthlyCreditsCents: config.monthlyCreditsCents,
        maxConcurrentAgents: config.maxConcurrentAgents,
        maxServers: config.maxServers,
        features: config.features,
        isActive: config.isActive,
      });
      console.log(`[UsageService] Seeded plan: ${id}`);
    } else {
      // Update existing plan with new config
      await db.update(plans)
        .set({
          name: config.name,
          description: config.description,
          monthlyPriceCents: config.monthlyPriceCents,
          monthlyCreditsCents: config.monthlyCreditsCents,
          maxConcurrentAgents: config.maxConcurrentAgents,
          maxServers: config.maxServers,
          features: config.features,
          isActive: config.isActive,
        })
        .where(eq(plans.id, planId));
    }
  }
}

/**
 * Get all available plans
 */
export async function getPlans(): Promise<Plan[]> {
  return db.query.plans.findMany({
    where: eq(plans.isActive, true),
  });
}

// ============================================================================
// Admin Functions
// ============================================================================

/**
 * Check if a user is an admin via the admin_users table.
 * Matches the console's adminPolicy.ts approach.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const result = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);
  return result.length > 0;
}

/**
 * Grant bonus credits to a user (admin only).
 *
 * Every admin credit grant MUST produce a usage_adjustments ledger row in the
 * same transaction. This function delegates to applyAdjustment to satisfy that
 * invariant. Direct use of addCredits here is prohibited.
 *
 * Note on grantCredits sign convention vs applyAdjustment:
 *   grantCredits(amountCents=1000) means "give the user $10 of credit" →
 *   balance should INCREASE. applyAdjustment treats negative amountCents as
 *   a refund/credit-grant (balance up), so we pass -amountCents.
 *
 * Circular-import note: UsageAdjustments.ts imports getOrCreateSubscription
 * from this file, so we cannot top-level import from UsageAdjustments here.
 * We use a lazy dynamic import inside the function body to avoid the cycle.
 */
export async function grantCredits(
  adminUserId: string,
  targetUserId: string,
  amountCents: number,
  reason?: string
): Promise<{ success: boolean; error?: string; newBalanceCents?: number }> {
  // Verify admin
  const adminCheck = await isAdmin(adminUserId);
  if (!adminCheck) {
    return { success: false, error: 'Unauthorized - admin access required' };
  }

  // Validate amount
  if (amountCents <= 0) {
    return { success: false, error: 'Amount must be positive' };
  }

  // Delegate to applyAdjustment so that a usage_adjustments ledger row is
  // written atomically with the balance update in the same transaction.
  const { applyAdjustment } = await import('./UsageAdjustments');
  await applyAdjustment({
    userId: targetUserId,
    adminUserId,
    amountCents: -amountCents,   // negative = credit grant (balance increases)
    reason: reason || 'Admin credit grant',
  });

  // Re-read balance to report back to the caller.
  // Drizzle returns numeric as a string — cast at the boundary.
  const sub = await getOrCreateSubscription(targetUserId);
  const newBalance = Number(sub.creditBalanceCents ?? 0);

  console.log(`[UsageService] Admin ${adminUserId} granted $${centsToDollars(amountCents)} to user ${targetUserId}${reason ? ` (${reason})` : ''}`);

  return { success: true, newBalanceCents: newBalance };
}

/**
 * Get user's current credit balance (for admin view)
 */
export async function getUserCredits(userId: string): Promise<{
  plan: PlanId;
  balanceCents: number;
  balanceDollars: number;
  periodSpentCents: number;
  email?: string;
} | null> {
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });

  if (!subscription) {
    return null;
  }

  const period = getBillingPeriod();
  const [spending, user] = await Promise.all([
    getPeriodSpending(userId, period.start, period.end),
    db.query.users.findFirst({ where: eq(users.id, userId) }),
  ]);

  // Drizzle returns numeric as a string — cast once at the boundary.
  const balanceCents = Number(subscription.creditBalanceCents ?? 0);
  return {
    plan: subscription.planId as PlanId,
    balanceCents,
    balanceDollars: centsToDollars(balanceCents),
    periodSpentCents: spending.totalCostCents,
    email: user?.email || undefined,
  };
}

// ============================================================================
// Period Spending Aggregation
// ============================================================================

export interface PeriodSpending {
  inputTokens: number;
  outputTokens: number;
  totalCostCents: number;
  requestCount: number;
}

/**
 * Sum spending for one user across a time range, across BOTH Claude-call events
 * and admin adjustments. Returns totals with sub-cent precision.
 *
 * Implemented as two aggregate queries in parallel; at RunHQ's scale this is
 * sub-millisecond. If usage grows 100x, add a materialized rollup then — not now.
 */
export async function getPeriodSpending(
  userId: string,
  start: Date,
  end: Date,
): Promise<PeriodSpending> {
  const [eventsAgg, adjAgg] = await Promise.all([
    db.select({
      inputTokens:    sql<number>`COALESCE(SUM(${usageEvents.inputTokens}),  0)::int`,
      outputTokens:   sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      totalCostCents: sql<number>`COALESCE(SUM(${usageEvents.costCents}), 0)::double precision`,
      requestCount:   sql<number>`COUNT(*)::int`,
    })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      gte(usageEvents.ts, start),
      lte(usageEvents.ts, end),
    )),

    db.select({
      totalAdjustCents: sql<number>`COALESCE(SUM(${usageAdjustments.amountCents}), 0)::double precision`,
    })
    .from(usageAdjustments)
    .where(and(
      eq(usageAdjustments.userId, userId),
      gte(usageAdjustments.ts, start),
      lte(usageAdjustments.ts, end),
    )),
  ]);

  const e = eventsAgg[0];
  const a = adjAgg[0];

  return {
    inputTokens:  e.inputTokens,
    outputTokens: e.outputTokens,
    totalCostCents: e.totalCostCents + a.totalAdjustCents,
    requestCount: e.requestCount,
  };
}

/**
 * List all users with their credit info (for admin view)
 */
export async function listUsersWithUsage(limit = 50, offset = 0): Promise<Array<{
  userId: string;
  email: string;
  plan: PlanId;
  balanceCents: number;
  balanceDollars: number;
  periodSpentCents: number;
  createdAt: Date;
}>> {
  const allSubscriptions = await db.query.subscriptions.findMany({
    with: {
      user: true,
    },
    limit,
    offset,
    orderBy: (subs, { desc }) => [desc(subs.createdAt)],
  });

  const period = getBillingPeriod();

  const result = await Promise.all(allSubscriptions.map(async (sub) => {
    const spending = await getPeriodSpending(sub.userId, period.start, period.end);
    // Drizzle returns numeric as a string — cast once at the boundary.
    const balanceCents = Number(sub.creditBalanceCents ?? 0);
    return {
      userId: sub.userId,
      email: sub.user?.email || 'unknown',
      plan: sub.planId as PlanId,
      balanceCents,
      balanceDollars: centsToDollars(balanceCents),
      periodSpentCents: spending.totalCostCents,
      createdAt: sub.createdAt,
    };
  }));

  return result;
}

