-- /app/data/home/be/src/db/migrations/2026-05-10-widget-runhq-member-detection.sql
--
-- Widget RunHQ member auto-recognition.
-- Spec: docs/superpowers/specs/2026-05-10-widget-runhq-member-detection-design.md
--
-- Adds the per-project allowlist + opt-in toggle that gate the cookie-based
-- auth path, and a discriminator on widget_users so app-identity and
-- runhq-identity rows for the same person never collide on the existing
-- (project_id, external_user_id) unique constraint.

BEGIN;

ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS allowed_origins text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS auto_recognize_runhq_members boolean NOT NULL DEFAULT false;

ALTER TABLE widget_users
  ADD COLUMN IF NOT EXISTS auth_source text NOT NULL DEFAULT 'app';

-- Replace the (project_id, external_user_id) unique with a compound that
-- includes auth_source. The new index is a strict superset: any pair that
-- was unique under the old index remains unique under the new one for the
-- default 'app' auth_source.
DROP INDEX IF EXISTS widget_users_project_external_unique;
CREATE UNIQUE INDEX IF NOT EXISTS widget_users_project_external_source_unique
  ON widget_users (project_id, external_user_id, auth_source);

COMMIT;
