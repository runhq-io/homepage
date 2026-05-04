-- workflow_cron_schedules: stores per-(server, agent, triggerNode) cron
-- schedules that the /be WorkflowCronScheduler fires on the tick interval.

CREATE TABLE IF NOT EXISTS workflow_cron_schedules (
  id                text        PRIMARY KEY,
  server_id         text        NOT NULL,
  agent_id          text        NOT NULL,
  workflow_version  integer     NOT NULL,
  trigger_node_id   text        NOT NULL,
  schedule          text        NOT NULL,
  timezone          text,
  next_fire_at      timestamptz NOT NULL,
  last_fired_at     timestamptz,
  enabled           boolean     NOT NULL DEFAULT true
);

-- Unique constraint: only one schedule per (server, agent, triggerNode).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_server_agent_node
  ON workflow_cron_schedules (server_id, agent_id, trigger_node_id);

-- Partial index used by the scheduler's polling query.
CREATE INDEX IF NOT EXISTS idx_next_fire
  ON workflow_cron_schedules (next_fire_at)
  WHERE enabled = true;
