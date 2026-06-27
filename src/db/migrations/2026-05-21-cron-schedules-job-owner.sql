-- 2026-05-21-cron-schedules-job-owner.sql
-- Extend workflow_cron_schedules to support job-scoped schedules in addition
-- to agent-scoped (template) schedules. Exactly one of agent_id/job_id is set.

ALTER TABLE workflow_cron_schedules
  ADD COLUMN job_id text;

ALTER TABLE workflow_cron_schedules
  ALTER COLUMN agent_id DROP NOT NULL;

ALTER TABLE workflow_cron_schedules
  ADD CONSTRAINT workflow_cron_schedules_owner_xor
  CHECK (num_nonnulls(agent_id, job_id) = 1);

-- Replace the old unique index — owner is now (agent_id OR job_id).
DROP INDEX IF EXISTS uniq_server_agent_node;

CREATE UNIQUE INDEX uniq_server_agent_node
  ON workflow_cron_schedules (server_id, agent_id, trigger_node_id)
  WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX uniq_server_job_node
  ON workflow_cron_schedules (server_id, job_id, trigger_node_id)
  WHERE job_id IS NOT NULL;
