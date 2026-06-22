-- Widget RBAC: role→permissions mapping + live-coder feature flag.
-- Replaces the binary assign_agent on/off with a flexible per-role permission
-- table. Existing projects that had agent assignment enabled get a '*' wildcard
-- entry that preserves the old "any authenticated user can assign" behaviour.

ALTER TABLE widget_projects ADD COLUMN IF NOT EXISTS widget_role_permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE widget_projects ADD COLUMN IF NOT EXISTS widget_live_coder_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE widget_projects
SET widget_role_permissions = '{"*": ["assign_agent"]}'::jsonb
WHERE widget_agent_assignment_enabled = true AND widget_role_permissions = '{}'::jsonb;
