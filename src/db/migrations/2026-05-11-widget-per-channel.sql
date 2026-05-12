-- /app/data/home/be/src/db/migrations/2026-05-11-widget-per-channel.sql
--
-- widget_projects re-keyed from workspace_project_id to channel_id.
--
-- Pre-req: the workspace reconciler (reconcileWidgetBindings Pass 2) has
-- populated channel_id on every row that previously had a workspace_project_id,
-- via the projectToPrimaryTodoChannel map. Any row still NULL after that
-- reconciliation is unrecoverable here -- operator intervention required.
--
-- Changes:
--   1. Hard abort if any row would violate NOT NULL.
--   2. Drop the workspace_project_id-keyed partial unique index.
--   3. Add a new unique index on (server_id, channel_id).
--   4. Make channel_id NOT NULL.
--
-- The workspace_project_id column itself is intentionally NOT dropped here;
-- Phase 5 cleanup removes it after this migration has soaked.

BEGIN;

-- Hard abort if any row would violate NOT NULL.
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count FROM widget_projects WHERE channel_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'widget_projects has % rows with NULL channel_id; backfill required before migration', null_count;
  END IF;
END $$;

DROP INDEX IF EXISTS widget_projects_server_workspace_project_unique;

CREATE UNIQUE INDEX IF NOT EXISTS widget_projects_server_channel_unique
  ON widget_projects (server_id, channel_id);

ALTER TABLE widget_projects ALTER COLUMN channel_id SET NOT NULL;

COMMIT;
