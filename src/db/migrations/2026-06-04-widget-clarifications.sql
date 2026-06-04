-- Clarification loop tables: one session per ticket (widget_clarifications)
-- and the individual questions within each session (widget_clarification_questions).
CREATE TABLE IF NOT EXISTS widget_clarifications (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id          UUID        NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  server_id        TEXT        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  widget_user_id   UUID        NOT NULL REFERENCES widget_users(id) ON DELETE CASCADE,
  agent_id         TEXT        NOT NULL,
  command          TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'asking',
  round            INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMP   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS widget_clarifications_task_id_idx
  ON widget_clarifications(task_id);

CREATE TABLE IF NOT EXISTS widget_clarification_questions (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clarification_id  UUID        NOT NULL REFERENCES widget_clarifications(id) ON DELETE CASCADE,
  prompt            TEXT        NOT NULL,
  options           JSONB,
  multiselect       BOOLEAN     NOT NULL DEFAULT false,
  status            TEXT        NOT NULL DEFAULT 'pending',
  answer            JSONB,
  round             INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMP   NOT NULL DEFAULT now(),
  answered_at       TIMESTAMP
);

CREATE INDEX IF NOT EXISTS widget_clarification_questions_clarification_id_idx
  ON widget_clarification_questions(clarification_id);
