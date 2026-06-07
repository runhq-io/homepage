-- Widget chat (agent intake): per-user conversations with the configured
-- support agent plus the message transcript. BE Postgres is the source of
-- truth; workspace agent loops rehydrate from here each turn.

ALTER TABLE widget_projects ADD COLUMN IF NOT EXISTS widget_chat_agent_entity_id TEXT;
ALTER TABLE widget_projects ADD COLUMN IF NOT EXISTS widget_chat_instructions TEXT;

CREATE TABLE IF NOT EXISTS widget_chat_conversations (
  id                 UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  widget_project_id  UUID        NOT NULL REFERENCES widget_projects(id) ON DELETE CASCADE,
  widget_user_id     UUID        NOT NULL REFERENCES widget_users(id) ON DELETE CASCADE,
  status             TEXT        NOT NULL DEFAULT 'active',
  created_task_id    UUID,
  user_turn_count    INTEGER     NOT NULL DEFAULT 0,
  pending_turn_id    UUID,
  created_at         TIMESTAMP   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS widget_chat_conversations_user_idx
  ON widget_chat_conversations(widget_project_id, widget_user_id);

CREATE TABLE IF NOT EXISTS widget_chat_messages (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id  UUID        NOT NULL REFERENCES widget_chat_conversations(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL,
  content          TEXT        NOT NULL DEFAULT '',
  payload          JSONB,
  turn_id          UUID,
  seq              INTEGER,
  created_at       TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS widget_chat_messages_conversation_idx
  ON widget_chat_messages(conversation_id, created_at);

-- Idempotency key for workspace event ingestion (retries cannot duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS widget_chat_messages_turn_seq_unique
  ON widget_chat_messages(turn_id, seq) WHERE turn_id IS NOT NULL;
