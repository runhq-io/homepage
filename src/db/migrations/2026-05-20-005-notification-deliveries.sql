CREATE TABLE notification_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('in_app','browser_api','web_push','apns','fcm','email')),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','skipped','failed','dead')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text NULL,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_channel_pending
  ON notification_deliveries(channel, next_attempt_at) WHERE status = 'pending';
CREATE INDEX notification_deliveries_notification_id
  ON notification_deliveries(notification_id);
