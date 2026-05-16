import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/services/InviteService', () => ({
  isUserActivated: vi.fn(),
}));

import * as InviteService from '../api/services/InviteService';
import { isSignupInviteRequired, assertActivated } from './signupGating';

describe('signupGating', () => {
  const ORIG = process.env.REQUIRE_SIGNUP_INVITE;
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    if (ORIG === undefined) delete process.env.REQUIRE_SIGNUP_INVITE;
    else process.env.REQUIRE_SIGNUP_INVITE = ORIG;
  });

  it('isSignupInviteRequired is false when env unset', () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    expect(isSignupInviteRequired()).toBe(false);
  });

  it('isSignupInviteRequired is false for any value other than "true"', () => {
    process.env.REQUIRE_SIGNUP_INVITE = 'false';
    expect(isSignupInviteRequired()).toBe(false);
    process.env.REQUIRE_SIGNUP_INVITE = '1';
    expect(isSignupInviteRequired()).toBe(false);
  });

  it('isSignupInviteRequired is true only for "true"', () => {
    process.env.REQUIRE_SIGNUP_INVITE = 'true';
    expect(isSignupInviteRequired()).toBe(true);
  });

  it('assertActivated returns true (pass) when gating off, without checking activation', async () => {
    delete process.env.REQUIRE_SIGNUP_INVITE;
    await expect(assertActivated('user-1')).resolves.toBe(true);
    expect(InviteService.isUserActivated).not.toHaveBeenCalled();
  });

  it('assertActivated defers to isUserActivated when gating on', async () => {
    process.env.REQUIRE_SIGNUP_INVITE = 'true';
    (InviteService.isUserActivated as any).mockResolvedValue(false);
    await expect(assertActivated('user-1')).resolves.toBe(false);
    (InviteService.isUserActivated as any).mockResolvedValue(true);
    await expect(assertActivated('user-2')).resolves.toBe(true);
    expect(InviteService.isUserActivated).toHaveBeenCalledWith('user-2');
  });
});
