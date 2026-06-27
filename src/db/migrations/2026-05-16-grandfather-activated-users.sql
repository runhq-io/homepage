-- One-time grandfather for invite-key signup gating.
-- Every account that exists before REQUIRE_SIGNUP_INVITE is enabled stays in;
-- only signups created after the flag flips are gated. Idempotent — re-running
-- is a no-op once all rows are already activated.
UPDATE users SET is_activated = true WHERE is_activated = false;
