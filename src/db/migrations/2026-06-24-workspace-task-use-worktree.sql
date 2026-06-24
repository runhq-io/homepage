-- Per-task worktree isolation.
--
-- A coding task can opt into running its assigned agent's job inside an
-- isolated git worktree+branch (and, on a GitHub-backed project, opening a PR
-- for review) instead of the shared checkout. The choice lives on the task so
-- one agent serves both modes — no duplicated "with worktree" agents.
--
-- Default FALSE: pre-existing tasks keep today's shared-checkout behavior; the
-- client defaults the checkbox ON only for git-backed coding tasks.

ALTER TABLE workspace_tasks
  ADD COLUMN IF NOT EXISTS use_worktree BOOLEAN NOT NULL DEFAULT false;
