-- notification_mutes.scope_id was mistakenly defined as uuid (migration 002),
-- but it stores the same heterogeneous text identifiers as notifications.server_id
-- and notifications.project_id: workspace server IDs in the form
-- ws_<base36>_<random>, and free-form project IDs. Neither is a UUID.
--
-- The mute gate (src/notifications/gates.ts applyGates) compares scope_id
-- against the incoming serverId/projectId. With a uuid column, Postgres tried
-- to cast a value like 'ws_mpi39xik_k6h45t' to uuid and raised
-- "invalid input syntax for type uuid". That error propagated out of
-- processDelivery BEFORE the per-channel delivery ran, so EVERY notification
-- delivery (in_app, browser_api, web_push, ...) was left stuck in 'pending'
-- and no notification ever reached the user.
--
-- This mirrors migration 008, which fixed the identical mistake on the
-- notifications table; scope_id was missed at the time. Changing to text lets
-- real IDs be stored and compared without casting. Postgres rebuilds the
-- dependent unique constraint/index automatically on the type change.
ALTER TABLE notification_mutes
  ALTER COLUMN scope_id TYPE text USING scope_id::text;
