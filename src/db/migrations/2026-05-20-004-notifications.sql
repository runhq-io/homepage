CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id      text NOT NULL UNIQUE,
  server_id     uuid NOT NULL,
  server_name   text NOT NULL,
  project_id    uuid NOT NULL,
  project_name  text NOT NULL,
  task_id       uuid NOT NULL,
  task_title    text NOT NULL,
  event_type    text NOT NULL CHECK (event_type IN ('need_help','completed')),
  read_at       timestamptz NULL,
  archived_at   timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unarchived
  ON notifications(user_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX notifications_user_unread
  ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX notifications_user_server_created
  ON notifications(user_id, server_id, created_at DESC);
