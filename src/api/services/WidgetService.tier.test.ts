import { describe, it, expect } from 'vitest';
import {
  permissionsForTier,
  isWidgetPermissionTier,
  WIDGET_PERMISSION_TIERS,
} from './WidgetService';

describe('widget permission tiers', () => {
  it('app_user can attach images only', () => {
    const p = permissionsForTier('app_user');
    expect(p.has('attach_image')).toBe(true);
    expect(p.has('assign_agent')).toBe(false);
    expect(p.has('live_coder')).toBe(false);
    expect(p.has('preview')).toBe(false);
  });

  it('staff has all four permissions', () => {
    const p = permissionsForTier('staff');
    expect([...p].sort()).toEqual(['assign_agent', 'attach_image', 'live_coder', 'preview']);
  });

  it('unknown/null tier falls back to app_user permissions', () => {
    for (const bad of ['bogus', '', null, undefined]) {
      const p = permissionsForTier(bad as never);
      expect(p.has('attach_image')).toBe(true);
      expect(p.has('assign_agent')).toBe(false);
    }
  });

  it('validates tier strings', () => {
    expect(isWidgetPermissionTier('staff')).toBe(true);
    expect(isWidgetPermissionTier('app_user')).toBe(true);
    expect(isWidgetPermissionTier('admin')).toBe(false);
    expect(isWidgetPermissionTier(undefined)).toBe(false);
    expect(WIDGET_PERMISSION_TIERS).toEqual(['app_user', 'staff']);
  });

  it('returns an independent set each call (no shared mutable state)', () => {
    const a = permissionsForTier('app_user') as Set<string>;
    a.add('assign_agent');
    expect(permissionsForTier('app_user').has('assign_agent')).toBe(false);
  });
});
