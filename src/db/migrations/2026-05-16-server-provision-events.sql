-- Provisioning transparency: a coarse current-step marker on the server row
-- plus an append-only per-server event log. Append-only avoids read-modify-
-- write races with the heartbeat/register handlers that legitimately clobber
-- servers.status. Idempotent: the runner applies each file once
-- (schema_migrations) but IF NOT EXISTS keeps it safe on partially-migrated
-- dev DBs.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS provision_step TEXT;

CREATE TABLE IF NOT EXISTS server_provision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS server_provision_events_server_id_created_at_idx
  ON server_provision_events (server_id, created_at ASC);
