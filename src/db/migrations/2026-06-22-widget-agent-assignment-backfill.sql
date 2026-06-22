-- Backfill widget_agent_assignment_enabled from the role-permissions map.
--
-- The 2026-06-18 RBAC migration set widget_role_permissions FROM the legacy
-- widget_agent_assignment_enabled column (one-time, forward direction). But the
-- new Permissions UI edits ONLY the role map, while the auto-assign orchestrator
-- (WidgetAutoAssign) and the creation-time injection guard still gate on the
-- legacy column. A project that granted assign_agent via the new UI after that
-- migration had the column left stale at false and so silently never
-- auto-assigned a freshly created widget ticket (no outcome was even recorded).
--
-- WidgetService now keeps the column in lock-step with the map on every settings
-- save; this backfills rows edited before that sync existed. Idempotent: only
-- flips false -> true for rows whose map already grants assign_agent to a role
-- (including the '*' everyone key).

UPDATE widget_projects
SET widget_agent_assignment_enabled = true, updated_at = NOW()
WHERE widget_agent_assignment_enabled = false
  AND widget_role_permissions IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_each(widget_role_permissions) e
    WHERE jsonb_typeof(e.value) = 'array' AND e.value @> '"assign_agent"'::jsonb
  );
