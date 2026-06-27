-- /app/data/home/be/src/db/migrations/2026-05-11-widget-per-channel.sql
--
-- widget_projects re-keyed from workspace_project_id to channel_id.
-- Phase A of a split rollout: index-only swap, safe to run with NULL channel_id rows.
--
-- This migration runs on every BE container start (Dockerfile CMD), so it MUST
-- be safe to apply BEFORE the workspace-side reconciler (Phase 2a) has had a
-- chance to populate channel_id. Postgres treats NULLs as distinct in unique
-- indexes, so creating the new unique index over a column with NULLs is safe.
--
-- The NOT NULL enforcement is deliberately deferred to a separate follow-up
-- migration (added to the repo only after operator verifies the backfill is
-- complete via `SELECT COUNT(*) FROM widget_projects WHERE channel_id IS NULL`).
--
-- Changes here:
--   1. Drop the workspace_project_id-keyed partial unique index.
--   2. Add a new unique index on (server_id, channel_id).
--
-- Deferred to a later migration once backfill is verified:
--   3. ALTER COLUMN channel_id SET NOT NULL.
--
-- The workspace_project_id column itself is intentionally NOT dropped here;
-- Phase 5 cleanup removes it after this migration has soaked.

BEGIN;

DROP INDEX IF EXISTS widget_projects_server_workspace_project_unique;

CREATE UNIQUE INDEX IF NOT EXISTS widget_projects_server_channel_unique
  ON widget_projects (server_id, channel_id);

COMMIT;
