import { db } from './index';
import { users, subscriptions } from './schema';

// Fixed UUID so the dev-local user's ID is stable across restarts.
// All-zeros prefix with 'de1' hex suffix makes this recognisable in logs/DB queries.
export const DEV_LOCAL_USER_ID = '00000000-0000-0000-0000-000000000de1';

/**
 * Seed a stable 'dev-local' user in non-prod environments.
 * Used as the fallback userId for the dev-mode auth bypass at
 * POST /api/claude/tools so events from unauthenticated dev calls
 * still satisfy the usage_events.user_id NOT NULL FK constraint.
 *
 * Idempotent — safe to call on every server startup.
 */
export async function seedDevLocalUser(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;

  try {
    const userResult = await db.insert(users).values({
      id: DEV_LOCAL_USER_ID,
      email: 'dev-local@runhq.invalid',
      name: 'Dev Local (sentinel)',
    } as any).onConflictDoNothing().returning({ id: users.id });

    if (userResult.length > 0) {
      console.log(`[seed] Inserted dev-local sentinel user id=${DEV_LOCAL_USER_ID}`);
    }

    // Ensure a subscription exists for the dev user — trackUsage assumes the row
    // exists (it does raw UPDATE, no getOrCreate). Without this, in-dev calls
    // write events with no matching balance deduction.
    const subResult = await db.insert(subscriptions).values({
      userId: DEV_LOCAL_USER_ID,
      planId: 'free',
      status: 'active',
      // numeric(12,4) column — pass as string. $10,000 — dev convenience; never hits zero.
      creditBalanceCents: '1000000.0000',
    } as any).onConflictDoNothing().returning({ id: subscriptions.id });

    if (subResult.length > 0) {
      console.log(`[seed] Inserted dev-local subscription for id=${DEV_LOCAL_USER_ID}`);
    }
  } catch (err) {
    // Match the error-handling pattern of sibling seeds (seedWorkerPersona /
    // seedCommanderPersona): log but don't throw, so server startup isn't blocked.
    console.error('[seed] seedDevLocalUser failed — continuing startup:', err);
  }
}
