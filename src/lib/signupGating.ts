/**
 * Signup-gating policy.
 *
 * When REQUIRE_SIGNUP_INVITE=true, a user must redeem an invite code
 * (users.is_activated=true) before performing privileged actions. When the
 * flag is off the product behaves as open-signup. This is the single source
 * of truth for the flag — never read process.env.REQUIRE_SIGNUP_INVITE
 * anywhere else.
 */
import { isUserActivated } from '../api/services/InviteService';

export function isSignupInviteRequired(): boolean {
  return process.env.REQUIRE_SIGNUP_INVITE === 'true';
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
