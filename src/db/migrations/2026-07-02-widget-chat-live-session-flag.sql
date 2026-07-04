-- Mark Live-session (staff↔coder relay + mirrored coder activity) chat messages
-- so a non-`live_coder` reader (e.g. the ticket reporter) never receives them.
-- A message is Live-session iff it was written after the conversation already
-- had a ticket (created_task_id); intake always precedes ticket creation, on an
-- active conversation that closes the moment it produces the ticket.

ALTER TABLE widget_chat_messages
  ADD COLUMN IF NOT EXISTS live_session BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any message on a ticket-linked conversation whose timestamp is after
-- that ticket's creation is Live-session content. Intake messages (before/at
-- ticket creation) stay false, so the reporter keeps their own transcript.
UPDATE widget_chat_messages m
SET live_session = true
FROM widget_chat_conversations c
JOIN workspace_tasks t ON t.id = c.created_task_id
WHERE m.conversation_id = c.id
  AND c.created_task_id IS NOT NULL
  AND m.created_at > t.created_at
  AND m.live_session = false;

-- Read filter is (conversation_id, live_session); extend the existing
-- conversation index isn't necessary — the conversation_idx already narrows to
-- one conversation, and live_session is a cheap post-filter on that small set.
