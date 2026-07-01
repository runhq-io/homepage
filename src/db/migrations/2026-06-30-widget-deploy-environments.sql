-- Per-widget-project deploy-environment id→name map, synced from the workspace
-- on the server heartbeat. Lets the widget resolve `deployed:<envId>` ticket
-- statuses to a human label ("Deployed → Production") on both the public page
-- and the live session. Nullable; the runner applies each file once
-- (schema_migrations) and IF NOT EXISTS keeps it safe on partially-migrated DBs.
ALTER TABLE widget_projects ADD COLUMN IF NOT EXISTS deploy_environments jsonb;
