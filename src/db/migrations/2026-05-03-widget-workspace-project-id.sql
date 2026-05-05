-- /app/data/home/be/src/db/migrations/2026-05-03-widget-workspace-project-id.sql
--
-- Per-project widget integrations.
--
-- Today widget_projects has a UNIQUE(server_id) constraint that codifies
-- "one widget per Fly machine". Workspaces host many RunHQ projects per
-- machine, so this stops a second project from getting its own widget and
-- causes the running widget to be reported on every project's settings
-- page.
--
-- Changes:
--   1. Add nullable workspace_project_id column.
--   2. Backfill from workspace_tasks where possible (any widget that has
--      ever produced a workspace_task knows its workspace project via
--      the channel join).
--   3. Drop UNIQUE(server_id); add a partial UNIQUE(server_id, workspace_project_id)
--      that only enforces uniqueness once the column is populated. This lets
--      us deploy the schema before backfill completes for every row.
--
-- Rows that cannot be backfilled stay NULL; the BE service layer treats them
-- as legacy until the per-machine reconciliation endpoint fills them in.
-- A follow-up migration will make the column NOT NULL once telemetry shows
-- zero NULL rows.

ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS workspace_project_id text;

UPDATE widget_projects wp
SET workspace_project_id = sub.workspace_project_id
FROM (
  SELECT DISTINCT ON (wt.workspace_channel_id, wt.server_id)
         wt.workspace_channel_id,
         wt.server_id,
         wt.workspace_project_id
  FROM workspace_tasks wt
  WHERE wt.workspace_project_id IS NOT NULL
    AND wt.workspace_project_id != ''
  ORDER BY wt.workspace_channel_id, wt.server_id, wt.created_at ASC
) AS sub
WHERE wp.channel_id = sub.workspace_channel_id
  AND wp.server_id  = sub.server_id
  AND wp.workspace_project_id IS NULL;

ALTER TABLE widget_projects
  DROP CONSTRAINT IF EXISTS widget_projects_server_id_unique;

CREATE UNIQUE INDEX IF NOT EXISTS widget_projects_server_workspace_project_unique
  ON widget_projects (server_id, workspace_project_id)
  WHERE workspace_project_id IS NOT NULL;
