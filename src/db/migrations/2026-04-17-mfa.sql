-- Add MFA flags to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamp;

-- Add workspace MFA enforcement flags
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS require_mfa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_mfa_enforced_at timestamp;

-- Per-user MFA methods (TOTP initially; extensible)
CREATE TABLE IF NOT EXISTS user_mfa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL,
  secret_encrypted text NOT NULL,
  secret_iv text NOT NULL,
  secret_auth_tag text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS user_mfa_user_method_idx ON user_mfa (user_id, method);

-- Recovery codes (one-shot, bcrypt-hashed)
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_recovery_codes_user_idx ON user_recovery_codes (user_id);
