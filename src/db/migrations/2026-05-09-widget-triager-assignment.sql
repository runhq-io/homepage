-- /app/data/home/be/src/db/migrations/2026-05-09-widget-triager-assignment.sql
--
-- Widget Triager Agent Assignment — schema additions
-- Spec: docs/superpowers/specs/2026-05-09-widget-triager-agent-assignment-design.md

BEGIN;

-- Project-level policy: master switch + role whitelist + claim name + rate limit.
ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS widget_agent_assignment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS widget_assign_roles text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS widget_role_claim_name text NOT NULL DEFAULT 'runhq_roles',
  ADD COLUMN IF NOT EXISTS widget_assign_rate_limit_per_hour integer NOT NULL DEFAULT 30;

-- Mirror table — read-only by BE widget endpoints; written only by the
-- workspace via /api/internal/servers/:serverId/widget-agents/sync.
CREATE TABLE IF NOT EXISTS widget_exposed_agents (
  widget_project_id uuid      NOT NULL REFERENCES widget_projects(id) ON DELETE CASCADE,
  agent_id          text      NOT NULL,
  agent_name        text      NOT NULL,
  agent_description text,
  updated_at        timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (widget_project_id, agent_id)
);

CREATE INDEX IF NOT EXISTS widget_exposed_agents_project_idx
  ON widget_exposed_agents(widget_project_id);

COMMIT;
