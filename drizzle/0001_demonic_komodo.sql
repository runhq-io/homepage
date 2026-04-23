CREATE TABLE "agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text,
	"character" text,
	"model" text,
	"enabled_tools" jsonb DEFAULT '["terminal","files"]'::jsonb,
	"starting_command" text,
	"job_start_command" text,
	"auto_start_tasks" boolean DEFAULT true,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_heal_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"triggered_by" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "usage_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"amount_cents" numeric(12, 4) NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"nickname" text NOT NULL,
	"last_used_at" timestamp,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"widget_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"api_key" text NOT NULL,
	"api_secret_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"auto_inject_in_preview" boolean DEFAULT false NOT NULL,
	"widget_position" text,
	"voting_period_hours" integer,
	"channel_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "widget_projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "widget_projects_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE "widget_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderation_status" text DEFAULT 'pending' NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'widget' NOT NULL,
	"widget_user_id" uuid,
	"yes_votes" integer DEFAULT 0 NOT NULL,
	"no_votes" integer DEFAULT 0 NOT NULL,
	"voting_ends_at" timestamp,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"fly_todo_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"name" text,
	"username" text,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"widget_user_id" uuid NOT NULL,
	"value" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_task_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"metadata" jsonb,
	"created_by_type" text DEFAULT 'member' NOT NULL,
	"created_by_id" text,
	"created_by_name" text,
	"legacy_workspace_activity_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_task_activity_server_legacy_activity_unique" UNIQUE("server_id","legacy_workspace_activity_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"storage_provider" text DEFAULT 'workspace-local' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text,
	"legacy_workspace_attachment_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_task_attachments_server_legacy_attachment_unique" UNIQUE("server_id","legacy_workspace_attachment_key")
);
--> statement-breakpoint
CREATE TABLE "workspace_task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_by_type" text DEFAULT 'member' NOT NULL,
	"created_by_id" text,
	"created_by_name" text,
	"legacy_workspace_comment_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "workspace_task_comments_server_legacy_comment_unique" UNIQUE("server_id","legacy_workspace_comment_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_task_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"voter_type" text DEFAULT 'member' NOT NULL,
	"voter_id" text NOT NULL,
	"value" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_task_votes_task_voter_unique" UNIQUE("task_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" text NOT NULL,
	"workspace_project_id" text,
	"workspace_channel_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"source_type" text DEFAULT 'workspace' NOT NULL,
	"created_by_type" text DEFAULT 'member' NOT NULL,
	"created_by_id" text,
	"created_by_name" text,
	"comments_disabled" boolean DEFAULT false NOT NULL,
	"task_type" text DEFAULT 'regular' NOT NULL,
	"schedule" text,
	"scheduled_at" bigint,
	"timezone" text,
	"completed_at" timestamp,
	"archived_at" timestamp,
	"deleted_at" timestamp,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"downvote_count" integer DEFAULT 0 NOT NULL,
	"moderation_status" text DEFAULT 'approved' NOT NULL,
	"metadata" jsonb,
	"voting_ends_at" timestamp,
	"legacy_workspace_todo_id" text,
	"last_migrated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tasks_server_legacy_todo_unique" UNIQUE("server_id","legacy_workspace_todo_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "require_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "require_mfa_enforced_at" timestamp;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "require_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "require_mfa_enforced_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "server_heal_attempts" ADD CONSTRAINT "server_heal_attempts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_heal_attempts" ADD CONSTRAINT "server_heal_attempts_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_comments" ADD CONSTRAINT "widget_comments_ticket_id_widget_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."widget_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_comments" ADD CONSTRAINT "widget_comments_widget_user_id_widget_users_id_fk" FOREIGN KEY ("widget_user_id") REFERENCES "public"."widget_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_tickets" ADD CONSTRAINT "widget_tickets_project_id_widget_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."widget_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_tickets" ADD CONSTRAINT "widget_tickets_widget_user_id_widget_users_id_fk" FOREIGN KEY ("widget_user_id") REFERENCES "public"."widget_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_users" ADD CONSTRAINT "widget_users_project_id_widget_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."widget_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_votes" ADD CONSTRAINT "widget_votes_ticket_id_widget_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."widget_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_votes" ADD CONSTRAINT "widget_votes_widget_user_id_widget_users_id_fk" FOREIGN KEY ("widget_user_id") REFERENCES "public"."widget_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_activity" ADD CONSTRAINT "workspace_task_activity_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_activity" ADD CONSTRAINT "workspace_task_activity_task_id_workspace_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_attachments" ADD CONSTRAINT "workspace_task_attachments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_attachments" ADD CONSTRAINT "workspace_task_attachments_task_id_workspace_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_comments" ADD CONSTRAINT "workspace_task_comments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_comments" ADD CONSTRAINT "workspace_task_comments_task_id_workspace_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_votes" ADD CONSTRAINT "workspace_task_votes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task_votes" ADD CONSTRAINT "workspace_task_votes_task_id_workspace_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_heal_attempts_server_started_idx" ON "server_heal_attempts" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE INDEX "usage_adjustments_user_ts_idx" ON "usage_adjustments" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_events_user_ts_idx" ON "usage_events" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_events_server_ts_idx" ON "usage_events" USING btree ("server_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_events_task_idx" ON "usage_events" USING btree ("task_id") WHERE task_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_events_agent_idx" ON "usage_events" USING btree ("agent_id") WHERE agent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_user_method_idx" ON "user_mfa" USING btree ("user_id","method");--> statement-breakpoint
CREATE INDEX "user_passkeys_user_idx" ON "user_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_idx" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash");
--> statement-breakpoint
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