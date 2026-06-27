-- Identifying metadata for widget users.
-- Stores the customer JWT's non-reserved claims (company, plan, account_id,
-- phone, …) so the Members tab can surface per-project identity columns.
-- Reserved/security claims (sub, name, email, fp, type, iat, exp, iss, aud,
-- jti, nbf, and the roles claim) are stripped before storing.

ALTER TABLE widget_users ADD COLUMN IF NOT EXISTS metadata JSONB;
