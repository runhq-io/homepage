CREATE TABLE notification_mutes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  text NOT NULL CHECK (scope_type IN ('server','project')),
  scope_id    uuid NOT NULL,
  expires_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_mutes_user_scope_unique UNIQUE (user_id, scope_type, scope_id)
);
CREATE INDEX notification_mutes_user_expires ON notification_mutes(user_id, expires_at);
