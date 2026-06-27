ALTER TABLE workspace_tasks ADD COLUMN last_interactor_user_id text NULL;
ALTER TABLE workspace_tasks ADD COLUMN last_interactor_at      timestamptz NULL;
CREATE INDEX workspace_tasks_last_interactor_user
  ON workspace_tasks(last_interactor_user_id)
  WHERE last_interactor_user_id IS NOT NULL;
