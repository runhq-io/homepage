-- /app/data/home/be/src/db/migrations/2026-05-12-widget-channel-not-null.sql
--
-- Phase B of the per-channel widget rollout. The Phase A migration
-- (2026-05-11-widget-per-channel.sql) swapped the unique index but
-- intentionally deferred enforcing NOT NULL on channel_id, because the
-- migration runs on every container boot and `widget_projects.channel_id`
-- was NULL on every legacy row at that point.
--
-- This Phase B migration enforces channel_id NOT NULL. It is added to the
-- repo only after operator has verified that:
--   1. The workspace reconciler (Pass 2) has populated channel_id on every
--      row whose owner workspace is still running.
--   2. Orphan rows belonging to deleted/missing workspaces have been
--      manually deleted (their referenced Fly apps no longer exist).
--
-- The pre-flight RAISE EXCEPTION below is defensive — it makes the
-- deploy fail loudly rather than silently corrupting prod if somehow a
-- new NULL channel_id row slipped in between operator verification and
-- this migration being shipped.

BEGIN;

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count FROM widget_projects WHERE channel_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'widget_projects has % rows with NULL channel_id; clean up before applying NOT NULL', null_count;
  END IF;
END $$;

ALTER TABLE widget_projects ALTER COLUMN channel_id SET NOT NULL;

COMMIT;
