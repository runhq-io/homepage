ALTER TABLE "usage_events" ADD COLUMN "job_id" text;--> statement-breakpoint
CREATE INDEX "usage_events_job_idx" ON "usage_events" USING btree ("job_id") WHERE job_id IS NOT NULL;