-- Indexes for workspace_task_activity_feed queries (server-wide listing, counts, member stats).
CREATE INDEX IF NOT EXISTS idx_workspace_task_activity_server_created_at
  ON workspace_task_activity (server_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_task_activity_server_creator_created
  ON workspace_task_activity (server_id, created_by_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_task_comments_server_created_at
  ON workspace_task_comments (server_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_task_comments_server_creator_created
  ON workspace_task_comments (server_id, created_by_id, created_at DESC);
