-- One-time grandfather: every account that exists before invite-gating is
-- enabled stays in. Idempotent — re-running is a no-op once all rows are true.
UPDATE "users" SET "is_activated" = true WHERE "is_activated" = false;
