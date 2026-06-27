-- Structural-op flag for migrateWorkspaceToOwnApp. Set TRUE while the
-- migrator is actively running (snapshot → restore → cutover → delete-old)
-- and cleared in finally. Distinct from `status` (operational state:
-- online/offline/error/etc.) because heartbeat + register handlers
-- legitimately clobber `status` to 'online' whenever a process inside the
-- workspace machine reaches the BE. Wake gates and the CF preview-router
-- Worker consult this column so a heartbeat can't bypass them mid-migration.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS migration_in_progress BOOLEAN NOT NULL DEFAULT FALSE;
