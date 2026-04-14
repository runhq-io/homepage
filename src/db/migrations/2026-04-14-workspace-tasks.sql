CREATE TABLE IF NOT EXISTS workspace_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id),
  workspace_project_id TEXT,
  workspace_channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  visibility TEXT NOT NULL DEFAULT 'private',
  source_type TEXT NOT NULL DEFAULT 'workspace',
  created_by_type TEXT NOT NULL DEFAULT 'member',
  created_by_id TEXT,
  created_by_name TEXT,
  comments_disabled BOOLEAN NOT NULL DEFAULT false,
  task_type TEXT NOT NULL DEFAULT 'regular',
  schedule TEXT,
  scheduled_at BIGINT,
  timezone TEXT,
  completed_at TIMESTAMP,
  archived_at TIMESTAMP,
  deleted_at TIMESTAMP,
  upvote_count INTEGER NOT NULL DEFAULT 0,
  legacy_workspace_todo_id TEXT,
  last_migrated_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_tasks_server_legacy_todo_unique UNIQUE (server_id, legacy_workspace_todo_id)
);

CREATE TABLE IF NOT EXISTS workspace_task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id),
  task_id UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_by_type TEXT NOT NULL DEFAULT 'member',
  created_by_id TEXT,
  created_by_name TEXT,
  legacy_workspace_comment_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP,
  CONSTRAINT workspace_task_comments_server_legacy_comment_unique UNIQUE (server_id, legacy_workspace_comment_id)
);

CREATE TABLE IF NOT EXISTS workspace_task_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id),
  task_id UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT,
  metadata JSONB,
  created_by_type TEXT NOT NULL DEFAULT 'member',
  created_by_id TEXT,
  created_by_name TEXT,
  legacy_workspace_activity_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_task_activity_server_legacy_activity_unique UNIQUE (server_id, legacy_workspace_activity_id)
);

CREATE TABLE IF NOT EXISTS workspace_task_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id),
  task_id UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'workspace-local',
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_name TEXT,
  legacy_workspace_attachment_key TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_task_attachments_server_legacy_attachment_unique UNIQUE (server_id, legacy_workspace_attachment_key)
);

CREATE TABLE IF NOT EXISTS workspace_task_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id),
  task_id UUID NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  voter_type TEXT NOT NULL DEFAULT 'member',
  voter_id TEXT NOT NULL,
  value BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_task_votes_task_voter_unique UNIQUE (task_id, voter_id)
);
