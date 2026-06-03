-- Maps a GitHub App installation (per GitHub account/org) to the RunHQ server
-- that initiated it. installation_id is GitHub's numeric installation id and is
-- globally unique, so it is the primary key. server_id FK ties access to a
-- workspace; ON DELETE CASCADE removes installs when a server is deleted.

CREATE TABLE IF NOT EXISTS github_app_installations (
  installation_id      BIGINT PRIMARY KEY,
  server_id            TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  account_login        TEXT NOT NULL,
  account_type         TEXT NOT NULL,
  repository_selection TEXT,
  suspended_at         TIMESTAMP,
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_app_installations_server_id_idx
  ON github_app_installations (server_id);
