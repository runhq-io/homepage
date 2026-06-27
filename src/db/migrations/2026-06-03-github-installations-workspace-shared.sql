-- Make GitHub App installations workspace-SHARED (many-to-many) instead of
-- bound 1:1 to a single server. An installation is a connection to a GitHub
-- account/org; it can be "available in" multiple workspaces. Usage is gated by
-- workspace membership + manage_project, not by who connected it.

-- 1. Join table: which workspaces an installation is available in.
CREATE TABLE IF NOT EXISTS github_installation_workspaces (
  installation_id   BIGINT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
  server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  added_by_user_id  UUID REFERENCES users(id),
  added_at          TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, server_id)
);

CREATE INDEX IF NOT EXISTS github_installation_workspaces_server_id_idx
  ON github_installation_workspaces (server_id);

-- 2. Record who connected each installation (audit). Backfill from the server's
--    owner while the authoritative server_id binding still exists.
ALTER TABLE github_app_installations
  ADD COLUMN IF NOT EXISTS connected_by_user_id UUID REFERENCES users(id);

UPDATE github_app_installations i
  SET connected_by_user_id = s.owner_id
  FROM servers s
  WHERE s.id = i.server_id AND i.connected_by_user_id IS NULL;

-- 3. Backfill the M2M table: one association per existing installation.
INSERT INTO github_installation_workspaces (installation_id, server_id, added_by_user_id)
  SELECT installation_id, server_id, connected_by_user_id
  FROM github_app_installations
  ON CONFLICT (installation_id, server_id) DO NOTHING;

-- 4. Drop the old 1:1 binding and its index — server_id is no longer authoritative.
DROP INDEX IF EXISTS github_app_installations_server_id_idx;
ALTER TABLE github_app_installations DROP COLUMN IF EXISTS server_id;
