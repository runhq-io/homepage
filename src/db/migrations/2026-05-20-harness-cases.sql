-- /tests harness — shared editable test suite.
--
-- The four cases below ship as the initial seed; after first deploy the
-- table is fully user-editable via /api/harness-cases (gated by
-- users.is_admin). ON CONFLICT DO NOTHING makes the seed idempotent and
-- non-destructive — a re-run never clobbers admin edits.

CREATE TABLE IF NOT EXISTS harness_cases (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  created_by      TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO harness_cases (id, label, prompt, expected_outcome) VALUES
  (
    'blog',
    'Daily blog → WordPress (concrete)',
    'make me a daily blog post about RunHQ and publish it to WordPress',
    'A multi-node executable graph: at least one trigger (a daily cron, and optionally a job-started trigger), a chat node that generates the blog post content, and an http (or terminal) node that publishes it to WordPress, terminating at an end node. The WordPress publish node must carry a clearly-marked credential placeholder rather than blocking the build. No "planner"/"dispatcher" chat node.'
  ),
  (
    'vague-blog',
    'Vague: "make daily blog posts" (must build first)',
    'make daily blog posts',
    'The agent must BUILD a sensible default pipeline immediately (cron + job-started trigger → chat generate → a publish or file-save node → end) and state its assumptions. It must NOT open with a clarifying question and must NOT end without a built graph. If it ever asks, it asks at most once and only AFTER a graph already exists.'
  ),
  (
    'cat',
    'Daily AI cat image → X/Twitter',
    'every morning generate an AI cat image and post it to X/Twitter',
    'A graph with a daily cron trigger → a node that generates an AI cat image (chat or http) → an http (or terminal) node that posts it to X/Twitter → end. The X/Twitter posting node carries a credential placeholder; the build is not blocked on it.'
  ),
  (
    'wp-blog',
    'Daily WordPress blog (structured creds + post-build refine)',
    'make daily wordpress blog articles',
    'A graph: cron + job-started triggers → a chat node that generates the article → an http node that publishes to WordPress → end. The http node uses a STRUCTURED `auth` object and lists its secret/url in `pendingCredentialFields` (NO `__NEEDS_*__` magic strings; the url is a syntactically valid placeholder). After building, the agent asks ONE focused batch of consequential refinement questions (schedule/cadence/topic/publish-state) with options — it does not silently assume nothing, and it does not ask before building.'
  )
ON CONFLICT (id) DO NOTHING;
