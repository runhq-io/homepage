import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/services/InviteService', () => ({
  isUserActivated: vi.fn(),
}));

import * as InviteService from '../api/services/InviteService';
import { isSignupInviteRequired, assertActivated } from './signupGating';

// NOTE: signup gating is currently TEMPORARILY FORCE-ON for all environments
// (see the header comment in signupGating.ts). These tests assert that
// hardcoded behavior. When the env toggle is restored, revert these to the
// env-driven assertions in git history (commit "signupGating policy module").
describe('signupGating (force-on)', () => {
  const ORIG = process.env.REQUIRE_SIGNUP_INVITE;
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    if (ORIG === undefined) delete process.env.REQUIRE_SIGNUP_INVITE;
    else process.env.REQUIRE_SIGNUP_INVITE = ORIG;
  });

  it('isSignupInviteRequired is true regardless of the env var (unset)', () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    expect(isSignupInviteRequired()).toBe(true);
  });

  it('isSignupInviteRequired stays true even when env explicitly says false', () => {
    process.env.REQUIRE_SIGNUP_INVITE = 'false';
    expect(isSignupInviteRequired()).toBe(true);
    process.env.REQUIRE_SIGNUP_INVITE = '0';
    expect(isSignupInviteRequired()).toBe(true);
  });

  it('assertActivated always defers to isUserActivated (gating never bypassed)', async () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    (InviteService.isUserActivated as any).mockResolvedValue(false);
    await expect(assertActivated('user-1')).resolves.toBe(false);
    (InviteService.isUserActivated as any).mockResolvedValue(true);
    await expect(assertActivated('user-2')).resolves.toBe(true);
    expect(InviteService.isUserActivated).toHaveBeenCalledWith('user-1');
    expect(InviteService.isUserActivated).toHaveBeenCalledWith('user-2');
  });
});
