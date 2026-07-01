import { describe, it, expect } from 'vitest';
import {
  resolveWidgetPermissions,
  effectiveWidgetRoleMap,
  defaultWidgetRolePermissions,
  defaultRoleForAuthSource,
  isAssignableWidgetRole,
  isWidgetPermission,
  WIDGET_ROLE_EVERYONE,
  WIDGET_ROLE_LOGGED_IN,
  WIDGET_ROLE_STAFF,
} from './WidgetService';

describe('widget role-based permissions', () => {
  describe('resolveWidgetPermissions with the default (empty) map', () => {
    it('anonymous gets only the everyone role — read-only board', () => {
      const p = resolveWidgetPermissions({}, null, false);
      expect(p.has('view_tickets')).toBe(true);
      expect(p.has('voter')).toBe(false);
      expect(p.has('ticket_creator')).toBe(false);
      expect(p.has('assign_agent')).toBe(false);
      expect(p.has('preview')).toBe(false);
    });

    it('a logged-in user gets read + vote + create (attach derives)', () => {
      const p = resolveWidgetPermissions({}, WIDGET_ROLE_LOGGED_IN, true);
      expect(p.has('view_tickets')).toBe(true);
      expect(p.has('voter')).toBe(true);
      expect(p.has('ticket_creator')).toBe(true);
      // attach_image is derived from ticket_creator
      expect(p.has('attach_image')).toBe(true);
      // but no elevated powers
      expect(p.has('assign_agent')).toBe(false);
      expect(p.has('preview')).toBe(false);
      expect(p.has('live_coder')).toBe(false);
    });

    it('a staff member gets everything (live derives from assign)', () => {
      const p = resolveWidgetPermissions({}, WIDGET_ROLE_STAFF, true);
      expect([...p].sort()).toEqual(
        ['assign_agent', 'attach_image', 'live_coder', 'preview', 'ticket_creator', 'view_tickets', 'voter'].sort(),
      );
    });
  });

  it('unions everyone + logged_in + assigned role, ignoring unknown perms', () => {
    const map = {
      everyone: ['view_tickets'],
      logged_in: ['view_tickets', 'voter'],
      moderator: ['ticket_creator', 'assign_agent', 'bogus_perm'],
    };
    const p = resolveWidgetPermissions(map, 'moderator', true);
    expect(p.has('view_tickets')).toBe(true);
    expect(p.has('voter')).toBe(true);
    expect(p.has('ticket_creator')).toBe(true);
    expect(p.has('assign_agent')).toBe(true);
    expect(p.has('live_coder')).toBe(true); // derived
    expect([...p].includes('bogus_perm' as never)).toBe(false);
  });

  it('an unknown assigned role contributes nothing beyond the baseline', () => {
    const map = { everyone: ['view_tickets'], logged_in: ['view_tickets', 'voter'] };
    const p = resolveWidgetPermissions(map, 'ghost_role', true);
    expect(p.has('voter')).toBe(true); // logged_in baseline still applies
    expect(p.has('assign_agent')).toBe(false);
  });

  it('everyone is NOT added twice / assigned role never leaks to anonymous', () => {
    const map = { everyone: ['view_tickets'], logged_in: ['voter'], staff: ['assign_agent'] };
    const anon = resolveWidgetPermissions(map, 'staff', false);
    expect(anon.has('view_tickets')).toBe(true);
    expect(anon.has('assign_agent')).toBe(false);
    expect(anon.has('voter')).toBe(false);
  });

  describe('effectiveWidgetRoleMap', () => {
    it('returns seeded defaults for an empty/absent map', () => {
      expect(effectiveWidgetRoleMap({})).toEqual(defaultWidgetRolePermissions());
      expect(effectiveWidgetRoleMap(null)).toEqual(defaultWidgetRolePermissions());
      expect(effectiveWidgetRoleMap(undefined)).toEqual(defaultWidgetRolePermissions());
    });
    it('returns the stored map once it carries a built-in role key', () => {
      const map = { everyone: [], logged_in: ['voter'] };
      expect(effectiveWidgetRoleMap(map)).toBe(map);
    });
    it('falls back to defaults for a legacy map with no built-in keys', () => {
      // Pre-tier maps were keyed by JWT role names / '*' and are vestigial.
      const legacy = { '*': ['attach_image'], team_member: ['assign_agent'] };
      expect(effectiveWidgetRoleMap(legacy)).toEqual(defaultWidgetRolePermissions());
    });
  });

  it('a logged-in user on a legacy map still gets the default baseline', () => {
    const legacy = { '*': ['attach_image'], team_member: ['assign_agent'] };
    const p = resolveWidgetPermissions(legacy, 'logged_in', true);
    expect(p.has('view_tickets')).toBe(true);
    expect(p.has('voter')).toBe(true);
    expect(p.has('ticket_creator')).toBe(true);
  });

  it('defaultRoleForAuthSource: runhq → staff, app → logged_in', () => {
    expect(defaultRoleForAuthSource('runhq')).toBe(WIDGET_ROLE_STAFF);
    expect(defaultRoleForAuthSource('app')).toBe(WIDGET_ROLE_LOGGED_IN);
  });

  describe('isAssignableWidgetRole', () => {
    const map = { everyone: ['view_tickets'], logged_in: ['voter'], staff: ['assign_agent'] };
    it('everyone is never assignable to an individual member', () => {
      expect(isAssignableWidgetRole(map, WIDGET_ROLE_EVERYONE)).toBe(false);
    });
    it('logged_in is always assignable', () => {
      expect(isAssignableWidgetRole({}, WIDGET_ROLE_LOGGED_IN)).toBe(true);
    });
    it('a defined custom role is assignable; an undefined one is not', () => {
      expect(isAssignableWidgetRole(map, 'staff')).toBe(true);
      expect(isAssignableWidgetRole(map, 'ghost')).toBe(false);
    });
    it('rejects non-string / empty', () => {
      expect(isAssignableWidgetRole(map, '')).toBe(false);
      expect(isAssignableWidgetRole(map, 123 as never)).toBe(false);
    });
  });

  it('isWidgetPermission validates the vocabulary', () => {
    for (const p of ['view_tickets', 'voter', 'ticket_creator', 'assign_agent', 'preview', 'live_coder', 'attach_image']) {
      expect(isWidgetPermission(p)).toBe(true);
    }
    expect(isWidgetPermission('manage_project')).toBe(false);
    expect(isWidgetPermission(undefined)).toBe(false);
  });
});
