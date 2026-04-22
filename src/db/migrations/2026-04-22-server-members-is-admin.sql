-- /app/data/home/be/src/db/migrations/2026-04-22-server-members-is-admin.sql
--
-- Adds a workspace-derived admin mirror column to server_members.
--
-- Background:
--   The BE's restart-permission check currently falls back to calling the
--   workspace's /permissions/check endpoint to determine if a non-owner is an
--   administrator. When the workspace is crashed, that HTTP call times out
--   and the check silently returns false — denying admins the ability to
--   restart at exactly the moment they need it most.
--
--   This column holds a mirror of the workspace's effective admin set, pushed
--   by the workspace on every role mutation and on boot. Cloud-op permission
--   checks read this column locally, so they succeed even when the workspace
--   is unreachable.
--
-- Source of truth: written only by POST /api/internal/servers/:serverId/admins/sync
-- (authenticated with SERVER_TOKEN). BE code never sets this column based on
-- its own logic.

ALTER TABLE server_members
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
