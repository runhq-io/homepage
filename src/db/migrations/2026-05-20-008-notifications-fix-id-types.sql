-- Fix notifications.server_id and notifications.project_id column types.
-- Phase 1 mistakenly defined them as uuid, but workspace server IDs use a
-- text format (ws_<base36>_<random>) and workspaceProjectId is a free-form
-- text identifier. Changing to text so real IDs can be stored without casting.
ALTER TABLE notifications
  ALTER COLUMN server_id TYPE text USING server_id::text,
  ALTER COLUMN project_id TYPE text USING project_id::text;

-- Rebuild the composite index that includes server_id (types changed).
DROP INDEX IF EXISTS notifications_user_server_created;
CREATE INDEX notifications_user_server_created
  ON notifications(user_id, server_id, created_at DESC);
