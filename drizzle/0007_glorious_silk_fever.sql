CREATE TABLE "widget_exposed_agents" (
	"widget_project_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"agent_description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "widget_exposed_agents_widget_project_id_agent_id_pk" PRIMARY KEY("widget_project_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_cron_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"trigger_node_id" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text,
	"next_fire_at" timestamp with time zone NOT NULL,
	"last_fired_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "migration_in_progress" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "workspace_project_id" text;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_login_url" text;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_language" text;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_agent_assignment_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_assign_roles" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_role_claim_name" text DEFAULT 'runhq_roles' NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "widget_assign_rate_limit_per_hour" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "allowed_origins" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_projects" ADD COLUMN "auto_recognize_runhq_members" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_users" ADD COLUMN "auth_source" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "widget_exposed_agents" ADD CONSTRAINT "widget_exposed_agents_widget_project_id_widget_projects_id_fk" FOREIGN KEY ("widget_project_id") REFERENCES "public"."widget_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widget_exposed_agents_project_idx" ON "widget_exposed_agents" USING btree ("widget_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_server_agent_node" ON "workflow_cron_schedules" USING btree ("server_id","agent_id","trigger_node_id");--> statement-breakpoint
CREATE INDEX "idx_next_fire" ON "workflow_cron_schedules" USING btree ("next_fire_at") WHERE enabled = true;--> statement-breakpoint
CREATE UNIQUE INDEX "widget_projects_server_channel_unique" ON "widget_projects" USING btree ("server_id","channel_id");
--> statement-breakpoint
UPDATE "workspace_tasks" SET "is_published" = true WHERE "source_type" <> 'widget';
