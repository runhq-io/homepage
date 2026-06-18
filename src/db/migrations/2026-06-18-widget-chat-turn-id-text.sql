-- Widen widget_chat_messages.turn_id from UUID to TEXT so that the
-- live-coder mirror can post events with turnId = 'live_coder_mirror'
-- (a stable non-UUID sentinel used for staff reply forwarding).
-- The unique partial index is recreated with the same semantics.

DROP INDEX IF EXISTS widget_chat_messages_turn_seq_unique;
ALTER TABLE widget_chat_messages ALTER COLUMN turn_id TYPE TEXT USING turn_id::text;
CREATE UNIQUE INDEX widget_chat_messages_turn_seq_unique
  ON widget_chat_messages(turn_id, seq)
  WHERE turn_id IS NOT NULL;
