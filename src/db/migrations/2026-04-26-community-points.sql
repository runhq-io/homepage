-- Add a soft-delete tombstone to widget_users for GDPR erasure.
-- ("Last seen" is provided by master's last_active_at column — not duplicated here.)
ALTER TABLE widget_users
  ADD COLUMN status text NOT NULL DEFAULT 'active';

ALTER TABLE widget_users
  ADD CONSTRAINT widget_users_status_check CHECK (status IN ('active', 'deleted'));

CREATE INDEX widget_users_project_active_idx
  ON widget_users(project_id) WHERE status = 'active';

-- Append-only point ledger
CREATE TABLE point_grants (
  id                  uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text       NOT NULL UNIQUE,
  project_id          uuid       NOT NULL REFERENCES widget_projects(id) ON DELETE CASCADE,
  widget_user_id      uuid       NOT NULL REFERENCES widget_users(id) ON DELETE CASCADE,
  amount              integer    NOT NULL,
  source              text       NOT NULL CHECK (source IN ('auto_completion','admin_grant','reversal','backfill')),
  reason              text,
  reason_code         text,
  ticket_id           uuid,
  reverses_grant_id   uuid       REFERENCES point_grants(id),
  granted_by_user_id  uuid,
  metadata            jsonb      NOT NULL DEFAULT '{}',
  created_at          timestamp  NOT NULL DEFAULT now()
);

CREATE INDEX point_grants_user_idx ON point_grants(project_id, widget_user_id);
CREATE INDEX point_grants_ticket_idx ON point_grants(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX point_grants_created_idx ON point_grants(created_at DESC);

-- CQRS balance projection
CREATE TABLE widget_user_balances (
  widget_user_id      uuid       PRIMARY KEY REFERENCES widget_users(id) ON DELETE CASCADE,
  project_id          uuid       NOT NULL REFERENCES widget_projects(id) ON DELETE CASCADE,
  balance             integer    NOT NULL DEFAULT 0,
  payouts_count       integer    NOT NULL DEFAULT 0,
  last_payout_at      timestamp,
  rank                integer
);

CREATE INDEX widget_user_balances_rank_idx ON widget_user_balances(project_id, rank);
CREATE INDEX widget_user_balances_balance_idx ON widget_user_balances(project_id, balance DESC);

-- Generic notification primitive
CREATE TABLE widget_user_notifications (
  id                  uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_user_id      uuid       NOT NULL REFERENCES widget_users(id) ON DELETE CASCADE,
  project_id          uuid       NOT NULL REFERENCES widget_projects(id) ON DELETE CASCADE,
  type                text       NOT NULL,
  payload             jsonb      NOT NULL,
  read_at             timestamp,
  created_at          timestamp  NOT NULL DEFAULT now()
);

CREATE INDEX widget_user_notifications_unread_idx
  ON widget_user_notifications(widget_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX widget_user_notifications_user_idx
  ON widget_user_notifications(widget_user_id, created_at DESC);
