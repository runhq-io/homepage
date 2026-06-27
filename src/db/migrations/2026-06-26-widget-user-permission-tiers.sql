-- Per-user widget permission tiers.
-- Replaces JWT-role-derived permissions (widget_role_permissions matched against
-- a JWT roles claim) with a permission tier stored directly on each widget user.
-- A user's effective permissions are now resolved from this tier, managed from
-- the RunHQ "Members" tab — no role map, no JWT claim wiring.
--
-- Tiers: 'app_user' (files tickets/chats + attaches images) and 'staff'
-- (full control: assign agents, live session, preview, attach images).
--
-- Also captures email (from the JWT email claim or the RunHQ user's email) and
-- a throttled last_active_at so the Members tab can show identity and activity.

ALTER TABLE widget_users ADD COLUMN IF NOT EXISTS permission_tier TEXT NOT NULL DEFAULT 'app_user';
ALTER TABLE widget_users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE widget_users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;

-- Backfill: RunHQ workspace teammates (cookie auth) are staff by default; all
-- other (app-issued) users start as app_user. Per-user role membership was never
-- stored, so app users who previously held elevated permissions via JWT roles are
-- re-granted individually in the Members tab.
UPDATE widget_users SET permission_tier = 'staff' WHERE auth_source = 'runhq';
