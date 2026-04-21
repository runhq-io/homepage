-- /app/data/home/be/src/db/migrations/2026-04-21-passkeys.sql

CREATE TABLE IF NOT EXISTS user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT ARRAY[]::text[],
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  nickname text NOT NULL,
  last_used_at timestamp,
  disabled_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_passkeys_user_idx ON user_passkeys (user_id);
