-- Drop the legacy usage_records table. All data was preserved via the
-- pre-cutover rollup events inserted by 2026-04-22-usage-events-adjustments.sql.
-- All code readers were migrated off usage_records in the same PR.
DROP TABLE IF EXISTS usage_records CASCADE;
