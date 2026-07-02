-- Server-side read state for the widget unread badge, per (widget user, ticket).
-- Two axes: seen_at (general activity) and live_session_seen_at (live-session
-- replies), mirroring the client's two localStorage seen-maps. Makes unread
-- state follow the user across devices instead of living in one browser only.
-- Idempotent so it is safe to (re-)run on any environment.
CREATE TABLE IF NOT EXISTS widget_ticket_reads (
  widget_user_id        uuid        NOT NULL REFERENCES widget_users(id) ON DELETE CASCADE,
  task_id               uuid        NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
  seen_at               timestamp,
  live_session_seen_at  timestamp,
  updated_at            timestamp   NOT NULL DEFAULT now(),
  PRIMARY KEY (widget_user_id, task_id)
);
