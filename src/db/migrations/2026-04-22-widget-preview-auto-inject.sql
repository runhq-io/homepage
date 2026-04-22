-- /app/data/home/be/src/db/migrations/2026-04-22-widget-preview-auto-inject.sql
--
-- Adds support for auto-injecting the widget into a server's preview URLs.
--
-- Schema changes:
--   1. New column `auto_inject_in_preview` on widget_projects (default false)
--   2. New UNIQUE constraint on widget_projects.server_id
--
-- The unique constraint formalises an invariant the service layer has always
-- assumed (one widget project per server). If any duplicates exist this
-- migration will fail — run the pre-check query from the PR description:
--   SELECT server_id, COUNT(*) FROM widget_projects GROUP BY server_id HAVING COUNT(*) > 1;

ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS auto_inject_in_preview boolean NOT NULL DEFAULT false;

ALTER TABLE widget_projects
  ADD CONSTRAINT widget_projects_server_id_unique UNIQUE (server_id);
