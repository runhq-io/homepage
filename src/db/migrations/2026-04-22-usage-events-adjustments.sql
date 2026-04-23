-- Migration: create usage_events and usage_adjustments tables
-- This migration creates the two new usage tracking tables and backfills
-- usage_events from the existing usage_records table as pre-cutover rollup rows.
-- usage_records itself is retained here; it will be dropped in a follow-up migration
-- after all code readers have been migrated off it.

CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" text,
	"ts" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT '0' NOT NULL,
	"task_id" text,
	"task_label" text,
	"channel_id" text,
	"channel_label" text,
	"agent_id" text,
	"agent_label" text,
	"conversation_id" text,
	"anthropic_request_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts" DESC NULLS LAST);
CREATE INDEX "usage_events_user_ts_idx" ON "usage_events" USING btree ("user_id","ts" DESC NULLS LAST);
CREATE INDEX "usage_events_server_ts_idx" ON "usage_events" USING btree ("server_id","ts" DESC NULLS LAST);
CREATE INDEX "usage_events_task_idx" ON "usage_events" USING btree ("task_id") WHERE task_id IS NOT NULL;
CREATE INDEX "usage_events_agent_idx" ON "usage_events" USING btree ("agent_id") WHERE agent_id IS NOT NULL;

CREATE TABLE "usage_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"amount_cents" numeric(12, 4) NOT NULL,
	"reason" text NOT NULL
);

ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "usage_adjustments_user_ts_idx" ON "usage_adjustments" USING btree ("user_id","ts" DESC NULLS LAST);

-- Backfill usage_events from usage_records as "pre-cutover" rollup rows.
-- ts is coerced to UTC explicitly (period_end is a tz-naive timestamp).
-- The usage_records table itself is dropped later, in a follow-up migration,
-- after all code readers have been migrated off it.
INSERT INTO usage_events (
  user_id, server_id, ts, model,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  cost_cents,
  task_id, task_label, channel_id, channel_label, agent_id, agent_label,
  conversation_id, anthropic_request_id
)
SELECT
  user_id,
  NULL,
  ((period_end - INTERVAL '1 second') AT TIME ZONE 'UTC'),
  'pre-cutover-rollup',
  input_tokens, output_tokens, 0, 0,
  total_cost_cents::numeric(12,4),
  NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL
FROM usage_records;
