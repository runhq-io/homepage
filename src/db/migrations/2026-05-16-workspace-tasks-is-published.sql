-- Add workspace_tasks.is_published — the second-layer gate for the widget
-- "Latest Updates" feed. Workspace-sourced tasks default published; widget-
-- submitted feedback (source_type='widget') stays unpublished until an admin
-- publishes it. Idempotent: the runner applies each file once (schema_migrations),
-- but IF NOT EXISTS keeps it safe against partially-migrated dev DBs.
ALTER TABLE workspace_tasks ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;
UPDATE workspace_tasks SET is_published = true WHERE source_type <> 'widget';
