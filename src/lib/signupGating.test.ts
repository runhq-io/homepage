import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/services/InviteService', () => ({
  isUserActivated: vi.fn(),
}));

import * as InviteService from '../api/services/InviteService';
import { isSignupInviteRequired, assertActivated } from './signupGating';

// EMERGENCY STOPGAP: signup gating is force-OFF (see signupGating.ts header) to
// recover from a client bug that walled every user. These tests assert the
// stopgap behavior. When gating is re-enabled, restore the env-driven
// assertions from git history (commit "signupGating policy module").
describe('signupGating (emergency stopgap: force-off)', () => {
  const ORIG = process.env.REQUIRE_SIGNUP_INVITE;
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    if (ORIG === undefined) delete process.env.REQUIRE_SIGNUP_INVITE;
    else process.env.REQUIRE_SIGNUP_INVITE = ORIG;
  });

  it('isSignupInviteRequired is false regardless of the env var (unset)', () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    expect(isSignupInviteRequired()).toBe(false);
  });

  it('isSignupInviteRequired stays false even when env explicitly says true', () => {
    process.env.REQUIRE_SIGNUP_INVITE = 'true';
    expect(isSignupInviteRequired()).toBe(false);
  });

  it('assertActivated always passes (gating disabled, no activation check)', async () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    await expect(assertActivated('user-1')).resolves.toBe(true);
    process.env.REQUIRE_SIGNUP_INVITE = 'true';
    await expect(assertActivated('user-2')).resolves.toBe(true);
    expect(InviteService.isUserActivated).not.toHaveBeenCalled();
  });
});
