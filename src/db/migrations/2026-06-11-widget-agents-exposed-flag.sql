-- Decouple widget chat-agent naming from the "Hand to agent" roster.
--
-- widget_exposed_agents becomes a mirror of ALL workspace agents (the
-- workspace server now pushes every agent, not just widget_exposed ones),
-- with an `exposed` flag marking membership in the assignable roster.
-- Name lookups (chat header, assigned events) ignore the flag, so a project
-- can name a chat support agent without enabling widget-user assignment.
--
-- Default TRUE: every pre-existing row was pushed by a workspace server that
-- only synced widget_exposed=true agents, so they are all exposed. The same
-- default keeps old workspace servers (which omit the field) working
-- unchanged until they pick up the new push payload.

ALTER TABLE widget_exposed_agents
  ADD COLUMN IF NOT EXISTS exposed BOOLEAN NOT NULL DEFAULT true;
