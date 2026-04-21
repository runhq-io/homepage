-- Server-level MFA enforcement (moved from organizations).
-- See src/lib/workspaceMfaEnforcement.ts and /api/servers/[id]/security.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS require_mfa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_mfa_enforced_at timestamp;
