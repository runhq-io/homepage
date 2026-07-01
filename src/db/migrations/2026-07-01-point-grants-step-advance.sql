-- Allow step-based awards in the point ledger.
-- Community step-coins grant one row per (ticket, tier, recipient); source = 'step_advance'.
ALTER TABLE point_grants DROP CONSTRAINT point_grants_source_check;

ALTER TABLE point_grants ADD CONSTRAINT point_grants_source_check
  CHECK (source IN ('auto_completion', 'admin_grant', 'reversal', 'backfill', 'step_advance'));
