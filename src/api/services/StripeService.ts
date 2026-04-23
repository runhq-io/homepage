/**
 * Stripe Service
 *
 * Handles Stripe integration for subscriptions, checkout, webhooks, and customer portal.
 */

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index';
import {
  subscriptions,
  payments,
  users,
  type PlanId,
  type SubscriptionStatus,
} from '../../db/schema';
import {
  updateSubscriptionPlan,
  getOrCreateSubscription,
  PLAN_CONFIG,
} from './UsageService';

// ============================================================================
// Stripe Client
// ============================================================================

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripe) {
    if (!stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY environment variable is not set');
    }
    stripe = new Stripe(stripeSecretKey);
  }
  return stripe;
}

// ============================================================================
// Price ID Mapping (configure these in Stripe Dashboard)
// ============================================================================

// Map plan IDs to Stripe Price IDs (set these as environment variables)
const STRIPE_PRICE_IDS: Record<PlanId, string | undefined> = {
  free: process.env.STRIPE_PRICE_FREE,       // $0 but requires card
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
  team: process.env.STRIPE_PRICE_TEAM,
};

// Reverse mapping from Stripe Price ID to Plan ID
function getPlanIdFromPriceId(priceId: string): PlanId | null {
  for (const [planId, stripePriceId] of Object.entries(STRIPE_PRICE_IDS)) {
    if (stripePriceId === priceId) {
      return planId as PlanId;
    }
  }
  return null;
}

// ============================================================================
// Checkout Session
// ============================================================================

export interface CreateCheckoutParams {
  userId: string;
  planId: PlanId;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(params: CreateCheckoutParams): Promise<string> {
  const { userId, planId, successUrl, cancelUrl } = params;
  const client = getStripe();

  const priceId = STRIPE_PRICE_IDS[planId];
  if (!priceId) {
    throw new Error(`Stripe price not configured for plan: ${planId}`);
  }

  // Get or create subscription to check for existing Stripe customer
  const subscription = await getOrCreateSubscription(userId);

  // Get user email
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  // Create checkout session
  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    customer: subscription.stripeCustomerId || undefined,
    customer_email: !subscription.stripeCustomerId && user?.email ? user.email : undefined,
    metadata: {
      userId,
      planId,
    },
    subscription_data: {
      metadata: {
        userId,
        planId,
      },
    },
  });

  if (!session.url) {
    throw new Error('Failed to create checkout session');
  }

  console.log(`[Stripe] Created checkout session for user ${userId}, plan ${planId}`);
  return session.url;
}

// ============================================================================
// Credit Top-Up (One-Time Purchase)
// ============================================================================

// Credit packs available for purchase
export const CREDIT_PACKS = [
  { id: 'credits_10', amountCents: 1000, creditsCents: 1000, label: '$10' },
  { id: 'credits_25', amountCents: 2500, creditsCents: 2500, label: '$25' },
  { id: 'credits_50', amountCents: 5000, creditsCents: 5000, label: '$50' },
  { id: 'credits_100', amountCents: 10000, creditsCents: 10000, label: '$100' },
] as const;

export type CreditPackId = typeof CREDIT_PACKS[number]['id'];

export interface CreateTopUpParams {
  userId: string;
  packId: CreditPackId;
  successUrl: string;
  cancelUrl: string;
}

export async function createTopUpSession(params: CreateTopUpParams): Promise<string> {
  const { userId, packId, successUrl, cancelUrl } = params;
  const client = getStripe();

  const pack = CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) {
    throw new Error(`Invalid credit pack: ${packId}`);
  }

  // Get or create subscription to get/create Stripe customer
  const subscription = await getOrCreateSubscription(userId);

  // Get user email
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  // Create one-time checkout session
  const session = await client.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: pack.amountCents,
          product_data: {
            name: `${pack.label} Credit Top-Up`,
            description: `Add ${pack.label} to your credit balance`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: userId,
    customer: subscription.stripeCustomerId || undefined,
    customer_email: !subscription.stripeCustomerId && user?.email ? user.email : undefined,
    metadata: {
      userId,
      type: 'topup',
      packId,
      creditsCents: pack.creditsCents.toString(),
    },
  });

  if (!session.url) {
    throw new Error('Failed to create top-up session');
  }

  console.log(`[Stripe] Created top-up session for user ${userId}, pack ${packId}`);
  return session.url;
}

// ============================================================================
// Customer Portal
// ============================================================================

export async function createPortalSession(userId: string, returnUrl: string): Promise<string> {
  const client = getStripe();

  // Get subscription to find Stripe customer ID
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  });

  if (!subscription?.stripeCustomerId) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await client.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: returnUrl,
  });

  console.log(`[Stripe] Created portal session for user ${userId}`);
  return session.url;
}

// ============================================================================
// Webhook Handler
// ============================================================================

export interface WebhookResult {
  success: boolean;
  message: string;
}

export async function handleWebhook(
  rawBody: string,
  signature: string
): Promise<WebhookResult> {
  const client = getStripe();

  if (!stripeWebhookSecret) {
    console.error('[Stripe] Webhook secret not configured');
    return { success: false, message: 'Webhook secret not configured' };
  }

  let event: Stripe.Event;

  try {
    event = client.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err);
    return { success: false, message: 'Invalid signature' };
  }

  console.log(`[Stripe] Received webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        console.log(`[Stripe] Unhandled event type: ${event.type}`);
    }

    return { success: true, message: `Processed ${event.type}` };
  } catch (error) {
    console.error(`[Stripe] Error handling webhook ${event.type}:`, error);
    return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// ============================================================================
// Webhook Event Handlers
// ============================================================================

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) {
    console.error('[Stripe] Checkout completed but no userId found');
    return;
  }

  const customerId = session.customer as string;

  // Check if this is a top-up (one-time payment) vs subscription
  if (session.metadata?.type === 'topup') {
    const creditsCents = parseInt(session.metadata.creditsCents || '0', 10);
    if (creditsCents > 0) {
      // Add credits to user's balance
      const subscription = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.userId, userId),
      });

      if (subscription) {
        // creditBalanceCents is numeric — Drizzle returns it as a string; cast first.
        const newBalance = Number(subscription.creditBalanceCents ?? 0) + creditsCents;
        await db.update(subscriptions)
          .set({
            // numeric column: pass as string.
            creditBalanceCents: newBalance.toFixed(4),
            stripeCustomerId: customerId || subscription.stripeCustomerId,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.userId, userId));

        console.log(`[Stripe] Top-up completed: user ${userId} added ${creditsCents} cents, new balance: ${newBalance}`);
      }
    }
    return;
  }

  // Handle subscription checkout
  const subscriptionId = session.subscription as string;
  if (!subscriptionId) {
    console.error('[Stripe] Subscription checkout but no subscription ID');
    return;
  }

  // Get subscription details to find the plan
  const client = getStripe();
  const stripeSubscription = await client.subscriptions.retrieve(subscriptionId) as Stripe.Subscription;
  const priceId = stripeSubscription.items.data[0]?.price.id;
  const planId = priceId ? getPlanIdFromPriceId(priceId) : null;

  if (!planId) {
    console.error('[Stripe] Could not determine plan from checkout session');
    return;
  }

  // Update subscription with Stripe info and new plan
  await updateSubscriptionPlan(userId, planId, subscriptionId, customerId);

  // Get period timestamps (handle both number and Date types)
  // Use any cast due to Stripe SDK type variations
  const sub = stripeSubscription as unknown as Record<string, unknown>;
  const periodStart = typeof sub.current_period_start === 'number'
    ? new Date(sub.current_period_start * 1000)
    : new Date();
  const periodEnd = typeof sub.current_period_end === 'number'
    ? new Date(sub.current_period_end * 1000)
    : new Date();

  // Update Stripe fields explicitly
  await db.update(subscriptions)
    .set({
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  console.log(`[Stripe] Checkout completed: user ${userId} upgraded to ${planId}`);
}

async function handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
  const userId = stripeSubscription.metadata?.userId;
  if (!userId) {
    console.log('[Stripe] Subscription updated but no userId in metadata');
    return;
  }

  const priceId = stripeSubscription.items.data[0]?.price.id;
  const planId = priceId ? getPlanIdFromPriceId(priceId) : null;

  // Map Stripe status to our status
  const statusMap: Record<string, SubscriptionStatus> = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    trialing: 'trialing',
    incomplete: 'incomplete',
    incomplete_expired: 'canceled',
    unpaid: 'past_due',
  };
  const status = statusMap[stripeSubscription.status] || 'active';

  // Get period timestamps safely (use any cast due to Stripe SDK type variations)
  const sub = stripeSubscription as unknown as Record<string, unknown>;
  const periodStart = typeof sub.current_period_start === 'number'
    ? new Date(sub.current_period_start * 1000)
    : new Date();
  const periodEnd = typeof sub.current_period_end === 'number'
    ? new Date(sub.current_period_end * 1000)
    : new Date();
  const canceledAt = typeof sub.canceled_at === 'number'
    ? new Date(sub.canceled_at * 1000)
    : null;

  await db.update(subscriptions)
    .set({
      planId: planId || undefined,
      stripePriceId: priceId,
      status,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      canceledAt,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  console.log(`[Stripe] Subscription updated for user ${userId}: ${status}, plan: ${planId}`);
}

async function handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
  const userId = stripeSubscription.metadata?.userId;
  if (!userId) {
    console.log('[Stripe] Subscription deleted but no userId in metadata');
    return;
  }

  // Downgrade to free tier
  await db.update(subscriptions)
    .set({
      planId: 'free',
      status: 'canceled',
      stripeSubscriptionId: null,
      stripePriceId: null,
      canceledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId));

  console.log(`[Stripe] Subscription deleted for user ${userId}, downgraded to free tier`);
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  // Find subscription by Stripe customer ID
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.stripeCustomerId, customerId),
  });

  if (!subscription) {
    console.log('[Stripe] Invoice paid but no subscription found for customer');
    return;
  }

  // Extract payment intent ID (use any cast due to Stripe SDK type variations)
  const inv = invoice as unknown as Record<string, unknown>;
  const paymentIntent = inv.payment_intent;
  const paymentIntentId = typeof paymentIntent === 'string'
    ? paymentIntent
    : (paymentIntent as Record<string, unknown> | null)?.id as string | undefined;

  // Record payment
  await db.insert(payments).values({
    userId: subscription.userId,
    subscriptionId: subscription.id,
    stripePaymentIntentId: paymentIntentId || undefined,
    stripeInvoiceId: invoice.id || undefined,
    amountCents: (inv.amount_paid as number) || 0,
    currency: (inv.currency as string) || 'usd',
    status: 'succeeded',
    description: `Subscription payment - ${subscription.planId}`,
    receiptUrl: (inv.hosted_invoice_url as string) || undefined,
  });

  // Update subscription status to active
  await db.update(subscriptions)
    .set({
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscription.id));

  console.log(`[Stripe] Invoice paid for user ${subscription.userId}: ${invoice.amount_paid / 100} ${invoice.currency}`);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  // Find subscription by Stripe customer ID
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.stripeCustomerId, customerId),
  });

  if (!subscription) {
    console.log('[Stripe] Invoice payment failed but no subscription found');
    return;
  }

  // Extract payment intent ID (use any cast due to Stripe SDK type variations)
  const inv = invoice as unknown as Record<string, unknown>;
  const paymentIntent = inv.payment_intent;
  const paymentIntentId = typeof paymentIntent === 'string'
    ? paymentIntent
    : (paymentIntent as Record<string, unknown> | null)?.id as string | undefined;

  // Record failed payment
  await db.insert(payments).values({
    userId: subscription.userId,
    subscriptionId: subscription.id,
    stripePaymentIntentId: paymentIntentId || undefined,
    stripeInvoiceId: invoice.id || undefined,
    amountCents: (inv.amount_due as number) || 0,
    currency: (inv.currency as string) || 'usd',
    status: 'failed',
    description: `Failed payment - ${subscription.planId}`,
  });

  // Update subscription status to past_due
  await db.update(subscriptions)
    .set({
      status: 'past_due',
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscription.id));

  console.log(`[Stripe] Invoice payment failed for user ${subscription.userId}`);
}

// ============================================================================
// Payment Method & Customer Lookup
// ============================================================================

/**
 * Get the default payment method (card) for a Stripe customer
 */
export async function getPaymentMethod(
  customerId: string
): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null> {
  const client = getStripe();
  try {
    const methods = await client.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });
    const card = methods.data[0]?.card;
    if (!card) return null;
    return {
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
    };
  } catch (err) {
    console.error('[Stripe] Failed to get payment method:', err);
    return null;
  }
}

/**
 * Find a Stripe customer by email and sync the customer ID, active subscription,
 * and plan to our DB. Returns the Stripe customer ID if found, null otherwise.
 */
export async function syncCustomerByEmail(
  userId: string,
  email: string
): Promise<string | null> {
  const client = getStripe();
  try {
    const customers = await client.customers.list({ email, limit: 1 });
    const customer = customers.data[0];
    if (!customer) return null;

    // Check for active Stripe subscription and sync plan
    const stripeSubscriptions = await client.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    const activeSub = stripeSubscriptions.data[0];
    const updateFields: Record<string, unknown> = {
      stripeCustomerId: customer.id,
      updatedAt: new Date(),
    };

    if (activeSub) {
      const priceId = activeSub.items.data[0]?.price.id;
      const planId = priceId ? getPlanIdFromPriceId(priceId) : null;

      if (planId) {
        updateFields.planId = planId;
        updateFields.status = 'active';
        updateFields.stripeSubscriptionId = activeSub.id;
        updateFields.stripePriceId = priceId;

        const sub = activeSub as unknown as Record<string, unknown>;
        if (typeof sub.current_period_start === 'number') {
          updateFields.currentPeriodStart = new Date(sub.current_period_start * 1000);
        }
        if (typeof sub.current_period_end === 'number') {
          updateFields.currentPeriodEnd = new Date(sub.current_period_end * 1000);
        }

        console.log(`[Stripe] Synced subscription for user ${userId}: plan=${planId}, sub=${activeSub.id}`);
      }
    }

    await db
      .update(subscriptions)
      .set(updateFields)
      .where(eq(subscriptions.userId, userId));

    console.log(`[Stripe] Synced customer ${customer.id} for user ${userId} via email lookup`);
    return customer.id;
  } catch (err) {
    console.error('[Stripe] Failed to sync customer by email:', err);
    return null;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function isStripeConfigured(): boolean {
  return !!stripeSecretKey;
}

export function getStripePriceIds(): Record<PlanId, string | undefined> {
  return STRIPE_PRICE_IDS;
}
