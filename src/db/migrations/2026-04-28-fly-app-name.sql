-- Per-tenant Fly app + 6PN network isolation. Each workspace lives in its
-- own Fly app on a dedicated --network so peers cannot reach each other on
-- Fly's private mesh. Both columns are nullable; null means the workspace
-- still lives in the legacy shared FLY_APP_NAME app (mixed-mode is supported
-- during the migration period). See runhq/docs/per-app-isolation-migration.md.
--
-- This is the same DDL drizzle-kit emitted into drizzle/0006_careful_post.sql
-- (committed in feat/per-app-isolation), restated here in the date-prefixed
-- format the runtime migration runner (scripts/run-migration.js) actually
-- applies. The drizzle/ output is for schema-state tracking only and is not
-- executed against the DB.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS fly_app_name TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS fly_network_name TEXT;
