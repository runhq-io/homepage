-- Add configurable session token expiry to servers table
-- null = use default (86400 seconds / 24 hours)
ALTER TABLE servers ADD COLUMN IF NOT EXISTS session_token_expiry_seconds INTEGER;
