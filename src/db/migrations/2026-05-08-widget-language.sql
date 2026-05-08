-- /app/data/home/be/src/db/migrations/2026-05-08-widget-language.sql
--
-- Per-widget UI language. Determines which locale strings the embeddable
-- widget renders for end users (composer placeholders, tab labels, empty
-- states, status chip labels, time-ago, etc.). The column is nullable so
-- existing rows fall through to English without backfill; we treat NULL
-- and 'en' as equivalent at the read site.
--
-- Supported values today: 'en' (default), 'ko'. Adding a new locale is a
-- one-line change in widget.js's locale table — no schema change needed,
-- so this column stays loosely typed (text, no CHECK constraint).

ALTER TABLE widget_projects
  ADD COLUMN IF NOT EXISTS widget_language text;
