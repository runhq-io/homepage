/**
 * Tests for attach_image opt-in enforcement.
 *
 * `attachImageAllowed` is a pure function (no DB) holding the gate logic:
 * uploads stay open until the project grants `attach_image` to at least one
 * role (incl. the '*' wildcard); after that, only users whose derived
 * permissions include attach_image may upload. This keeps widgets created
 * before the permission existed working unchanged.
 */
import { describe, it, expect } from 'vitest';
import { attachImageAllowed } from './WidgetService.js';

const perms = (...keys: string[]) => new Set(keys) as ReadonlySet<any>;

describe('attachImageAllowed (opt-in gate)', () => {
  it('allows uploads when no role configures attach_image (back-compat)', () => {
    // Empty map → nobody is gated, regardless of the user's permission set.
    expect(attachImageAllowed({}, perms())).toBe(true);
    expect(attachImageAllowed(undefined, perms())).toBe(true);
    expect(attachImageAllowed(null, perms())).toBe(true);
  });

  it('allows uploads when other permissions are configured but not attach_image', () => {
    const map = { staff: ['assign_agent', 'live_coder'], '*': ['assign_agent'] };
    // attach_image is unused anywhere → still open for everyone.
    expect(attachImageAllowed(map, perms())).toBe(true);
    expect(attachImageAllowed(map, perms('assign_agent'))).toBe(true);
  });

  it('enforces once a role grants attach_image: permits users who have it', () => {
    const map = { staff: ['attach_image'] };
    expect(attachImageAllowed(map, perms('attach_image'))).toBe(true);
  });

  it('enforces once a role grants attach_image: denies users who lack it', () => {
    const map = { staff: ['attach_image'] };
    expect(attachImageAllowed(map, perms())).toBe(false);
    expect(attachImageAllowed(map, perms('assign_agent', 'live_coder'))).toBe(false);
  });

  it('treats a wildcard grant as configured (deny only those without the derived perm)', () => {
    const map = { '*': ['attach_image'] };
    // A user whose derived set includes attach_image (via '*') is allowed…
    expect(attachImageAllowed(map, perms('attach_image'))).toBe(true);
    // …but the gate is "configured", so a set lacking it is denied. (In
    // practice derivePermissions would grant it via '*', but the gate must not
    // silently re-open just because the wildcard is present.)
    expect(attachImageAllowed(map, perms())).toBe(false);
  });
});
