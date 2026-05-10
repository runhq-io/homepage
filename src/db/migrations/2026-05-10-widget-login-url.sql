-- /app/data/home/be/src/db/migrations/2026-05-10-widget-login-url.sql
--
-- Public widget — interactive with login URL redirect (anon write gate).
-- Spec: docs/superpowers/specs/2026-05-10-public-widget-interactive-with-login-url-design.md
--
-- Adds a nullable widget_login_url column to widget_projects. When the
-- project is public, the widget redirects anonymous viewers attempting
-- a write action (submit, vote, comment) to this URL with their draft
-- preserved in sessionStorage, so they can complete the action after
-- logging in. The column is nullable for backward compatibility with
-- existing public projects; the application layer enforces "required
-- when is_public=true" on settings updates going forward.

BEGIN;

ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS widget_login_url text;

COMMIT;
