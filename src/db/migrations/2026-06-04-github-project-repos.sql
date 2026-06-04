-- Central mirror of project -> GitHub repo links, synced up from each server
-- machine, so the cloud BE can aggregate open PRs across all of a user's
-- servers. Cache semantics: cascade-deletes with the server or installation.
CREATE TABLE IF NOT EXISTS github_project_repos (
  server_id        TEXT   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  project_id       TEXT   NOT NULL,
  installation_id  BIGINT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
  owner            TEXT   NOT NULL,
  repo             TEXT   NOT NULL,
  project_name     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, project_id)
);

CREATE INDEX IF NOT EXISTS github_project_repos_installation_idx
  ON github_project_repos(installation_id);
