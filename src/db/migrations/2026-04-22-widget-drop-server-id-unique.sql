-- /app/data/home/be/src/db/migrations/2026-04-22-widget-drop-server-id-unique.sql
--
-- Rolls back the UNIQUE constraint on widget_projects.server_id added by
-- 2026-04-22-widget-preview-auto-inject.sql.
--
-- Rationale: the service layer currently treats serverId → widget as 1:1,
-- but the product model (widget_projects.channel_id already exists) points
-- toward N widgets per workspace — one per channel. Locking the 1:1 into
-- the DB would force a future schema migration before multi-widget work
-- could start. The invariant stays enforced at the service layer for now;
-- if/when multi-widget lands, the lookups get redesigned as part of that
-- work.
--
-- `IF EXISTS` guards make the migration safe whether or not the earlier
-- migration's constraint was applied (e.g. different envs in different
-- states).

ALTER TABLE widget_projects
  DROP CONSTRAINT IF EXISTS widget_projects_server_id_unique;
