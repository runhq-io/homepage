-- Widget permissions move from a per-user tier (app_user/staff) to a
-- role→permissions model. `widget_projects.widget_role_permissions` (already
-- present) becomes the source of truth, and `widget_users.permission_tier` now
-- stores an assigned ROLE KEY (column name retained for stability).
--
-- Role keys:
--   everyone   built-in, applies to every visitor (anon + authenticated)
--   logged_in  built-in, applies to every authenticated user (default baseline)
--   staff      seeded elevated role (assign agents + preview); editable
--   <custom>   any additional role an admin defines in the grid
--
-- Effective permissions resolve in code (resolveWidgetPermissions):
--   effective = everyone ∪ (authenticated ? logged_in ∪ assignedRole : ∅)
-- Projects with an empty map fall back to seeded defaults at runtime, so no
-- backfill of widget_role_permissions is needed here (only the member column).

-- Remap the two legacy tiers onto the new built-in roles. 'staff' is unchanged
-- (it's now a seeded role of the same name); 'app_user' becomes the baseline
-- 'logged_in'. Any other/unknown value is normalized to the baseline too so a
-- stale row always resolves to a valid, non-elevated role.
UPDATE widget_users SET permission_tier = 'logged_in' WHERE permission_tier = 'app_user';
UPDATE widget_users SET permission_tier = 'logged_in'
  WHERE permission_tier IS NULL OR permission_tier NOT IN ('logged_in', 'staff', 'everyone');

-- New members default to the baseline role instead of the old app_user tier.
ALTER TABLE widget_users ALTER COLUMN permission_tier SET DEFAULT 'logged_in';
