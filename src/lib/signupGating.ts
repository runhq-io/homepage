/**
 * Signup-gating policy.
 *
 * This is the single source of truth for whether signup gating is on —
 * never read process.env.REQUIRE_SIGNUP_INVITE anywhere else.
 *
 * !!! FORCE-ON (2026-05-16, by explicit request) !!!
 * Gating is hardcoded on for ALL environments. The env-controlled behavior
 * (`process.env.REQUIRE_SIGNUP_INVITE === 'true'`) is intentionally bypassed.
 * To restore the toggle, replace the body of isSignupInviteRequired() with
 * that expression and update signupGating.test.ts accordingly.
 *
 * History: this was briefly forced false (stopgap 5b941f3) to recover from a
 * client bug where ActivationGate read `approved` off the wrong store path
 * and walled every user. That client fix (0d6f34ef) is verified live, so
 * gating is force-on again — existing users are activated (grandfather
 * migration) and pass straight through; only un-activated/new users are gated.
 *
 * SAFETY DEPENDENCY: existing users are only spared a lockout if the
 * grandfather migration
 * `src/db/migrations/2026-05-16-grandfather-activated-users.sql` has run on
 * the target database. The Dockerfile CMD runs `scripts/run-migration.js`
 * before the server starts, so DO/container deploys are safe by construction.
 * Local dev must `pnpm db:migrate` before starting the server, or every
 * pre-existing local user is locked behind the invite wall.
 */
import { isUserActivated } from '../api/services/InviteService';

export function isSignupInviteRequired(): boolean {
  return true;
}

/**
 * Returns true if the user is allowed to proceed:
 *  - gating off  -> always true (no DB read)
 *  - gating on   -> true iff the user is activated
 */
export async function assertActivated(userId: string): Promise<boolean> {
  if (!isSignupInviteRequired()) return true;
  return isUserActivated(userId);
}
