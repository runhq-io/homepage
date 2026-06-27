-- Add duplicate_of_task_id column to widget_clarifications.
-- Populated only when status='duplicate', null otherwise.
ALTER TABLE widget_clarifications
  ADD COLUMN IF NOT EXISTS duplicate_of_task_id TEXT;
