-- Change creditBalanceCents from integer to numeric(12,4) to match
-- usage_events.cost_cents precision. Eliminates sub-cent rounding drift
-- that accumulated under the previous Math.round deduction path.
-- The USING clause is required: Postgres won't implicitly cast integer
-- to numeric in an ALTER COLUMN TYPE. Integer values become `N.0000`.
ALTER TABLE subscriptions
  ALTER COLUMN credit_balance_cents TYPE numeric(12,4) USING credit_balance_cents::numeric(12,4);

ALTER TABLE subscriptions
  ALTER COLUMN credit_balance_cents SET DEFAULT '0';
