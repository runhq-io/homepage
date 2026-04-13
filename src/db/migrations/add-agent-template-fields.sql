-- Add model, starting commands, and auto-start to agent templates
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS starting_command TEXT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS job_start_command TEXT;
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS auto_start_tasks BOOLEAN DEFAULT true;
