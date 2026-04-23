-- Add job_id column + partial index to usage_events so the admin /usage
-- page can break down by job execution (in addition to task). Nullable —
-- events without a job context (ad-hoc /api/claude/tools calls, background
-- summaries not tied to a job) stay null.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS job_id text;
CREATE INDEX IF NOT EXISTS usage_events_job_idx ON usage_events (job_id) WHERE job_id IS NOT NULL;
