-- /app/data/home/be/src/db/migrations/2026-04-22-server-heal-attempts.sql
--
-- Audit log + concurrency control for workspace auto-heal and admin-triggered
-- restarts.
--
-- A heal "attempt" captures one restart cycle:
--   - Insert with status='in_progress' when BE calls Fly's restartMachine
--   - Update to 'succeeded' when the workspace's /health returns 200
--   - Update to 'failed' on 2-minute timeout or provider error
--
-- The partial unique index enforces the invariant that at most one
-- in-progress attempt exists per server at a time. This is the primary
-- concurrency-control mechanism — two racing auto-heal requests can both
-- pass the logical check, but only one will successfully insert the
-- in-progress row. The loser reads the existing row and returns the same
-- attempt ID to its client.

CREATE TABLE IF NOT EXISTS server_heal_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id      text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  triggered_by   uuid NOT NULL REFERENCES users(id),
  started_at     timestamp NOT NULL DEFAULT now(),
  completed_at   timestamp,
  status         text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  error_message  text
);

-- For cooldown + flap lookups by (server, recent).
CREATE INDEX IF NOT EXISTS server_heal_attempts_server_started_idx
  ON server_heal_attempts (server_id, started_at DESC);

-- Partial unique index: at most one in-progress heal per server.
-- Drizzle 0.38 cannot emit this, so it lives here authoritatively.
CREATE UNIQUE INDEX IF NOT EXISTS server_heal_attempts_one_in_progress_idx
  ON server_heal_attempts (server_id)
  WHERE status = 'in_progress';
