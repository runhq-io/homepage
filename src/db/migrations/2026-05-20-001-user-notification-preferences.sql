CREATE TABLE user_notification_preferences (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app_enabled   boolean NOT NULL DEFAULT true,
  browser_enabled  boolean NOT NULL DEFAULT true,
  push_enabled     boolean NOT NULL DEFAULT true,
  email_enabled    boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
