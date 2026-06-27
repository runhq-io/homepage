-- Add channel_id to notifications so clicking a notification can deep-link to
-- the workspace channel where the job/task lives (its agent chat). The
-- canonical task carries workspace_channel_id; we snapshot it onto the
-- notification at emit time. Nullable: test notifications and tasks with no
-- channel simply have no deep-link target (the client falls back to the server).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel_id text;
