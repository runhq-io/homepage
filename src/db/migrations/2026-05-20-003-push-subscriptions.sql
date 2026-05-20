CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('web_push','apns','fcm')),
  endpoint      text NOT NULL,
  keys          jsonb NULL,
  user_agent    text NULL,
  last_used_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_user_platform_endpoint_unique UNIQUE (user_id, platform, endpoint)
);
CREATE INDEX push_subscriptions_user_platform ON push_subscriptions(user_id, platform);
