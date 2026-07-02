import { describe, it, expect } from 'vitest';
import {
  resolveWidgetPermissions,
  effectiveWidgetRoleMap,
  widgetRoleMapForDisplay,
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

    it('a logged-in user gets read + vote + create + attach images', () => {
      const p = resolveWidgetPermissions({}, WIDGET_ROLE_LOGGED_IN, true);
      expect(p.has('view_tickets')).toBe(true);
      expect(p.has('voter')).toBe(true);
      expect(p.has('ticket_creator')).toBe(true);
      // attach_image is a seeded default grant for logged_in
      expect(p.has('attach_image')).toBe(true);
      // but no elevated powers
      expect(p.has('assign_agent')).toBe(false);
      expect(p.has('preview')).toBe(false);
      expect(p.has('live_coder')).toBe(false);
    });

    it('a staff member gets everything (live derives from assign) incl. approve_tickets', () => {
      const p = resolveWidgetPermissions({}, WIDGET_ROLE_STAFF, true);
      expect([...p].sort()).toEqual(
        ['approve_tickets', 'assign_agent', 'attach_image', 'live_coder', 'preview', 'ticket_creator', 'view_tickets', 'voter'].sort(),
      );
    });

    it('approve_tickets is a staff-only default — not everyone or logged_in', () => {
      const anon = resolveWidgetPermissions({}, null, false);
      const loggedIn = resolveWidgetPermissions({}, WIDGET_ROLE_LOGGED_IN, true);
      const staff = resolveWidgetPermissions({}, WIDGET_ROLE_STAFF, true);
      expect(anon.has('approve_tickets')).toBe(false);
      expect(loggedIn.has('approve_tickets')).toBe(false);
      expect(staff.has('approve_tickets')).toBe(true);
    });

    it('anonymous is clamped even if the everyone role grants approve_tickets', () => {
      const map = { everyone: ['view_tickets', 'approve_tickets'] };
      expect([...resolveWidgetPermissions(map, null, false)]).toEqual(['view_tickets']);
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

  it('clamps anonymous to view_tickets even if the everyone role over-grants', () => {
    const map = { everyone: ['view_tickets', 'voter', 'ticket_creator', 'assign_agent', 'preview'] };
    const anon = resolveWidgetPermissions(map, null, false);
    expect([...anon]).toEqual(['view_tickets']);
    // and no derived caps leak in (attach/live derive from create/assign)
    expect(anon.has('attach_image')).toBe(false);
    expect(anon.has('live_coder')).toBe(false);
    // an authenticated user on the SAME map is unaffected by the clamp
    const authed = resolveWidgetPermissions(map, null, true);
    expect(authed.has('voter')).toBe(true);
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
    for (const p of ['view_tickets', 'voter', 'ticket_creator', 'attach_image', 'assign_agent', 'preview', 'approve_tickets', 'live_coder']) {
      expect(isWidgetPermission(p)).toBe(true);
    }
    expect(isWidgetPermission('manage_project')).toBe(false);
    expect(isWidgetPermission(undefined)).toBe(false);
  });

  describe('attach_image is an independent, authoritative grid column', () => {
    // Legacy (pre-column) maps are materialized ONCE by the
    // 2026-07-02-widget-attach-image-backfill migration, so by the time these
    // functions run the stored map is always authoritative: attach_image is
    // present exactly where an admin checked it. There is no runtime derivation
    // from ticket_creator — otherwise unchecking attach_image on every role
    // could never persist (its absence would be re-read as "legacy, derive it").

    it('does NOT derive attach_image from ticket_creator (absence is intentional)', () => {
      // This is the reported bug: attach_image unchecked on every role. The
      // stored map grants it nowhere, and it must STAY off after a round-trip.
      const map = {
        everyone: ['view_tickets'],
        logged_in: ['view_tickets', 'voter', 'ticket_creator'],
        hello: ['view_tickets', 'ticket_creator'],
      };
      expect(resolveWidgetPermissions(map, WIDGET_ROLE_LOGGED_IN, true).has('attach_image')).toBe(false);
      expect(resolveWidgetPermissions(map, 'hello', true).has('attach_image')).toBe(false);
    });

    it('grants attach_image only where a role lists it explicitly', () => {
      const map = {
        everyone: ['view_tickets'],
        logged_in: ['view_tickets', 'voter', 'ticket_creator'],
        moderator: ['view_tickets', 'attach_image'],
      };
      expect(resolveWidgetPermissions(map, WIDGET_ROLE_LOGGED_IN, true).has('attach_image')).toBe(false);
      expect(resolveWidgetPermissions(map, 'moderator', true).has('attach_image')).toBe(true);
    });

    it('can be granted to a role WITHOUT ticket_creator (decoupled)', () => {
      const map = { everyone: ['view_tickets'], logged_in: ['view_tickets', 'attach_image'] };
      const p = resolveWidgetPermissions(map, WIDGET_ROLE_LOGGED_IN, true);
      expect(p.has('attach_image')).toBe(true);
      expect(p.has('ticket_creator')).toBe(false);
    });

    it('anonymous never gets attach_image', () => {
      const map = { everyone: ['view_tickets', 'ticket_creator', 'attach_image'] };
      expect(resolveWidgetPermissions(map, null, false).has('attach_image')).toBe(false);
    });
  });

  describe('widgetRoleMapForDisplay is a pass-through of the stored map', () => {
    it('returns the stored map unchanged when attach_image is absent everywhere', () => {
      // The grid must reflect exactly what is stored — no re-materialization —
      // so an admin who unchecks attach_image everywhere sees it stay unchecked.
      const map = { everyone: ['view_tickets'], logged_in: ['view_tickets', 'voter', 'ticket_creator'], hello: ['view_tickets', 'ticket_creator'] };
      expect(widgetRoleMapForDisplay(map)).toEqual(map);
    });

    it('returns the stored map unchanged when attach_image is explicit', () => {
      const map = { everyone: ['view_tickets'], logged_in: ['view_tickets', 'ticket_creator', 'attach_image'], staff: ['view_tickets'] };
      expect(widgetRoleMapForDisplay(map)).toEqual(map);
    });

    it('falls back to seeded defaults for an unconfigured (empty) map', () => {
      expect(widgetRoleMapForDisplay({})).toEqual(defaultWidgetRolePermissions());
    });
  });
});
