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
  usageRecords,
  plans,
  adminUsers,
  type PlanId,
  type Subscription,
  type UsageRecord,
  type Plan,
} from '../../db/schema';
import type { TokenUsage } from '@runhq/server-protocol';

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
// Cost Calculation (based on Claude pricing)
// ============================================================================

// Pricing per 1M tokens (approximate, adjust as needed)
const INPUT_TOKEN_COST_PER_MILLION = 300;   // $3.00 per 1M input tokens
const OUTPUT_TOKEN_COST_PER_MILLION = 1500; // $15.00 per 1M output tokens

export function calculateCostCents(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * INPUT_TOKEN_COST_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_TOKEN_COST_PER_MILLION;
  // Round to nearest cent, minimum 1 cent if any tokens used
  const totalCents = Math.round(inputCost + outputCost);
  return inputTokens + outputTokens > 0 ? Math.max(1, totalCents) : 0;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getBillingPeriod(date: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractUserIdFromToken(token: string): string | null {
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
    creditBalanceCents: planConfig.monthlyCreditsCents,
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

  // Add monthly credits + signup bonus to balance
  const creditsToAdd = planConfig.monthlyCreditsCents + (grantSignupBonus ? planConfig.signupBonusCents : 0);
  const newBalance = (existing.creditBalanceCents || 0) + creditsToAdd;

  const [updated] = await db.update(subscriptions)
    .set({
      planId: newPlanId,
      stripeSubscriptionId: stripeSubscriptionId || existing.stripeSubscriptionId,
      stripeCustomerId: stripeCustomerId || existing.stripeCustomerId,
      creditBalanceCents: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId))
    .returning();

  console.log(`[UsageService] Updated subscription for user ${userId}: ${existing.planId} → ${newPlanId}`);
  console.log(`[UsageService] Added $${centsToDollars(creditsToAdd)} credits, new balance: $${centsToDollars(newBalance)}`);

  return updated;
}

/**
 * Add credits to user's balance (for purchases or admin grants)
 */
export async function addCredits(userId: string, amountCents: number): Promise<number> {
  const subscription = await getOrCreateSubscription(userId);
  const newBalance = (subscription.creditBalanceCents || 0) + amountCents;

  await db.update(subscriptions)
    .set({
      creditBalanceCents: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  console.log(`[UsageService] Added $${centsToDollars(amountCents)} to user ${userId}, new balance: $${centsToDollars(newBalance)}`);
  return newBalance;
}

// ============================================================================
// Usage Record Management
// ============================================================================

/**
 * Get or create the current billing period usage record for a user
 */
export async function getOrCreateCurrentUsageRecord(userId: string): Promise<UsageRecord> {
  const { start, end } = getBillingPeriod();

  // Look for existing record for current period
  const existing = await db.query.usageRecords.findFirst({
    where: and(
      eq(usageRecords.userId, userId),
      gte(usageRecords.periodStart, start),
      lte(usageRecords.periodEnd, end)
    ),
  });

  if (existing) {
    return existing;
  }

  // Create new record for this billing period
  const [newRecord] = await db.insert(usageRecords).values({
    userId,
    periodStart: start,
    periodEnd: end,
    inputTokens: 0,
    outputTokens: 0,
    totalCostCents: 0,
    requestCount: 0,
  }).returning();

  return newRecord;
}

// ============================================================================
// Usage Tracking
// ============================================================================

/**
 * Track usage and deduct from credit balance
 * Returns the cost and new balance
 */
export async function trackUsage(
  userToken: string | null | undefined,
  tokenUsage: TokenUsage
): Promise<UsageTrackResult> {
  console.log(`[UsageService] trackUsage called with token: ${userToken ? userToken.substring(0, 30) + '...' : 'none'}`);
  console.log(`[UsageService] tokenUsage:`, JSON.stringify(tokenUsage));

  if (!userToken) {
    console.warn('[UsageService] No user token provided, skipping usage tracking');
    return { costCents: 0, newBalanceCents: 0 };
  }

  const userId = extractUserIdFromToken(userToken);
  if (!userId) {
    console.warn('[UsageService] Could not extract userId from token');
    return { costCents: 0, newBalanceCents: 0 };
  }

  console.log(`[UsageService] trackUsage for userId: ${userId}`);

  // Calculate cost
  const costCents = tokenUsage.costCents > 0
    ? Math.round(tokenUsage.costCents)
    : calculateCostCents(tokenUsage.inputTokens, tokenUsage.outputTokens);

  // Deduct from credit balance
  const subscription = await getOrCreateSubscription(userId);
  const newBalance = Math.max(0, (subscription.creditBalanceCents || 0) - costCents);

  await db.update(subscriptions)
    .set({
      creditBalanceCents: newBalance,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  // Update usage record (for analytics/history)
  const usageRecord = await getOrCreateCurrentUsageRecord(userId);
  await db.update(usageRecords)
    .set({
      inputTokens: sql`${usageRecords.inputTokens} + ${tokenUsage.inputTokens}`,
      outputTokens: sql`${usageRecords.outputTokens} + ${tokenUsage.outputTokens}`,
      totalCostCents: sql`${usageRecords.totalCostCents} + ${costCents}`,
      requestCount: sql`${usageRecords.requestCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(usageRecords.id, usageRecord.id));

  console.log(`[UsageService] User ${userId}: spent $${centsToDollars(costCents)}, balance: $${centsToDollars(newBalance)}`);

  return { costCents, newBalanceCents: newBalance };
}

// Legacy alias
export const trackTokenUsage = trackUsage;

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
  const usageRecord = await getOrCreateCurrentUsageRecord(userId);

  console.log(`[UsageService] getCreditBalance - periodSpentCents: ${usageRecord.totalCostCents}, requestCount: ${usageRecord.requestCount}`);

  return {
    balanceCents: subscription.creditBalanceCents || 0,
    balanceDollars: centsToDollars(subscription.creditBalanceCents || 0),
    plan: subscription.planId as PlanId,
    hasPaymentMethod: !!subscription.stripeCustomerId,
    periodSpentCents: usageRecord.totalCostCents || 0,
    periodRequestCount: usageRecord.requestCount || 0,
    periodStart: usageRecord.periodStart,
    periodEnd: usageRecord.periodEnd,
  };
}

// Legacy alias
export const getUsage = getCreditBalance;

/**
 * Check if user has enough credits
 */
export async function checkCreditBalance(userToken: string): Promise<CreditCheckResult> {
  const userId = extractUserIdFromToken(userToken);
  if (!userId) {
    return {
      allowed: false,
      reason: 'no_subscription',
      balanceCents: 0,
      plan: 'free',
    };
  }

  const subscription = await getOrCreateSubscription(userId);

  // Check subscription status
  if (subscription.status === 'past_due') {
    return {
      allowed: false,
      reason: 'past_due',
      balanceCents: subscription.creditBalanceCents || 0,
      plan: subscription.planId as PlanId,
    };
  }

  const balance = subscription.creditBalanceCents || 0;

  // Need at least 1 cent to make a request
  if (balance < 1) {
    return {
      allowed: false,
      reason: 'insufficient_credits',
      balanceCents: balance,
      plan: subscription.planId as PlanId,
    };
  }

  return {
    allowed: true,
    balanceCents: balance,
    plan: subscription.planId as PlanId,
  };
}

// Legacy alias
export const checkUsageLimit = checkCreditBalance;

/**
 * Get usage records for a time period
 */
export async function getUsageRecords(
  userToken: string,
  startTime?: number,
  endTime?: number
): Promise<UsageRecord[]> {
  const userId = extractUserIdFromToken(userToken);
  if (!userId) {
    return [];
  }

  const start = startTime ? new Date(startTime) : new Date(0);
  const end = endTime ? new Date(endTime) : new Date();

  return db.query.usageRecords.findMany({
    where: and(
      eq(usageRecords.userId, userId),
      gte(usageRecords.periodStart, start),
      lte(usageRecords.periodEnd, end)
    ),
    orderBy: (records, { desc }) => [desc(records.periodStart)],
  });
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
 * Grant bonus credits to a user (admin only)
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

  // Add credits
  const newBalance = await addCredits(targetUserId, amountCents);

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

  const usageRecord = await getOrCreateCurrentUsageRecord(userId);

  // Get user email
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  return {
    plan: subscription.planId as PlanId,
    balanceCents: subscription.creditBalanceCents || 0,
    balanceDollars: centsToDollars(subscription.creditBalanceCents || 0),
    periodSpentCents: usageRecord.totalCostCents || 0,
    email: user?.email || undefined,
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

  const result = [];
  for (const sub of allSubscriptions) {
    const usageRecord = await db.query.usageRecords.findFirst({
      where: and(
        eq(usageRecords.userId, sub.userId),
        gte(usageRecords.periodStart, getBillingPeriod().start),
      ),
    });

    result.push({
      userId: sub.userId,
      email: sub.user?.email || 'unknown',
      plan: sub.planId as PlanId,
      balanceCents: sub.creditBalanceCents || 0,
      balanceDollars: centsToDollars(sub.creditBalanceCents || 0),
      periodSpentCents: usageRecord?.totalCostCents || 0,
      createdAt: sub.createdAt,
    });
  }

  return result;
}

// ============================================================================
// Legacy Compatibility
// ============================================================================

export function clearUsageCache(): void {
  // No-op: database-backed now
}

export function clearUsageRecords(): void {
  // No-op: database-backed now
}

// Legacy type alias
export type UsageSummary = CreditBalance;
export type UsageLimitResult = CreditCheckResult & {
  currentUsage?: number;
  limit?: number;
  upgradeOptions?: PlanId[];
};
