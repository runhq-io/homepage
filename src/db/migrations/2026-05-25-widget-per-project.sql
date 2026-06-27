-- /app/data/home/be/src/db/migrations/2026-05-25-widget-per-project.sql
--
-- Re-pivot widget_projects identity from (server_id, channel_id) back to
-- (server_id, workspace_project_id): one widget per PROJECT, with channel_id
-- now the mutable "target todo channel" the widget feeds.
--
-- Runtime resolution (ticket submit, identity, public page, preview-inject)
-- keys by slug / api_key and only READS channel_id for routing, so existing
-- embedded widgets keep working — api_key / api_secret_hash / slug are preserved.
--
-- Steps:
--   1. Dedupe: a project may currently own widgets on several channels. Keep the
--      most-recently-updated row per (server_id, workspace_project_id); orphan
--      the rest non-destructively (workspace_project_id = NULL, enabled = false)
--      so they don't violate the new index and can be inspected/rolled back.
--   2. Drop the per-channel unique index.
--   3. Create a PARTIAL unique index on (server_id, workspace_project_id) where
--      workspace_project_id IS NOT NULL (Postgres treats NULLs as distinct, so
--      orphaned rows coexist).
--
-- channel_id stays NOT NULL (every widget needs a target list) — unchanged.

BEGIN;

-- 1. Orphan duplicate widgets within a project, keeping the newest.
UPDATE widget_projects
SET workspace_project_id = NULL, enabled = false, updated_at = now()
WHERE workspace_project_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (server_id, workspace_project_id) id
    FROM widget_projects
    WHERE workspace_project_id IS NOT NULL
    ORDER BY server_id, workspace_project_id, updated_at DESC
  );

-- 2. Drop the per-channel unique index.
DROP INDEX IF EXISTS widget_projects_server_channel_unique;

-- 3. Add the partial per-project unique index (mirrors the original
--    widget_projects_server_workspace_project_unique that existed pre-Phase-A).
CREATE UNIQUE INDEX IF NOT EXISTS widget_projects_server_workspace_project_unique
  ON widget_projects (server_id, workspace_project_id)
  WHERE workspace_project_id IS NOT NULL;

COMMIT;
