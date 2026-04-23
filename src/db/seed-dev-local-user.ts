import { db } from './index';
import { users } from './schema';

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
    const result = await db.insert(users).values({
      id: DEV_LOCAL_USER_ID,
      email: 'dev-local@runhq.invalid',
      name: 'Dev Local (sentinel)',
    } as any).onConflictDoNothing().returning({ id: users.id });

    if (result.length > 0) {
      console.log(`[seed] Inserted dev-local sentinel user id=${DEV_LOCAL_USER_ID}`);
    }
    // If result is empty, the row already existed — silent no-op (idempotent).
  } catch (err) {
    // Match the error-handling pattern of sibling seeds (seedWorkerPersona /
    // seedCommanderPersona): log but don't throw, so server startup isn't blocked.
    console.error('[seed] seedDevLocalUser failed — continuing startup:', err);
  }
}
