-- Task status lifecycle overhaul.
--
-- The flat status set (pending | planned | in_progress | needs_review | done |
-- deployed | cancelled) is replaced by a PR-lifecycle-driven set:
--   pending -> planned -> in_progress -> done -> reviewed -> merged
--           -> deployed:<envId>   (+ cancelled, any time)
--
-- `needs_review` is removed and folded into `done` (which now means "work
-- complete, PR up, awaiting review"). `done` rows are left untouched; bare
-- `deployed` rows are left untouched (their environment is unknown).
--
-- The status columns are plain TEXT (no CHECK constraint), so only data needs
-- migrating — the new `reviewed` / `merged` / `deployed:<env>` values are
-- accepted as-is.

UPDATE workspace_tasks SET status = 'done' WHERE status = 'needs_review';
UPDATE widget_tickets  SET status = 'done' WHERE status = 'needs_review';
