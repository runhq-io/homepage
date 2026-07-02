-- Materialize the legacy `attach_image ⇐ ticket_creator` derivation into the
-- stored widget role maps, one time, so the map becomes the single source of
-- truth for the attach_image grid column.
--
-- Background: `attach_image` shipped as its own Permissions-grid column after the
-- role→permissions model was already live. To avoid pre-column projects silently
-- losing image upload, the resolver used to DERIVE attach_image from
-- ticket_creator whenever no role granted it explicitly. That inference is
-- fundamentally ambiguous: it cannot distinguish a genuinely-legacy map from one
-- where an admin deliberately unchecked attach_image on every role — so
-- unchecking it everywhere could never persist (it re-appeared on the next load).
--
-- This migration writes the derivation into the data for exactly the maps the
-- resolver used to derive for, after which the runtime derivation is removed
-- (see resolveWidgetPermissions / widgetRoleMapForDisplay). Post-migration, the
-- absence of attach_image unambiguously means "off", and all future writes come
-- from the attach_image-aware grid, which persists the column explicitly.
--
-- Target set (identical to the old derivation's firing condition):
--   * the stored map carries a built-in role key (`everyone`/`logged_in`), i.e.
--     it was saved by the grid rather than falling back to seeded defaults — a
--     null/empty or legacy pre-tier map already resolves through the seeded
--     defaults, which include attach_image, so it needs no backfill; AND
--   * no role in the map grants attach_image; AND
--   * at least one role grants ticket_creator.
-- For those maps, append `attach_image` to every role list that has
-- ticket_creator but not attach_image. Idempotent: re-running is a no-op because
-- the "no role grants attach_image" guard no longer holds once applied.

UPDATE widget_projects wp
SET widget_role_permissions = rebuilt.new_map
FROM (
  SELECT p.id,
         jsonb_object_agg(
           e.key,
           CASE
             WHEN jsonb_typeof(e.value) = 'array'
                  AND e.value ? 'ticket_creator'
                  AND NOT (e.value ? 'attach_image')
               THEN e.value || '["attach_image"]'::jsonb
             ELSE e.value
           END
         ) AS new_map
  FROM widget_projects p,
       LATERAL jsonb_each(p.widget_role_permissions) AS e(key, value)
  WHERE (p.widget_role_permissions ? 'everyone' OR p.widget_role_permissions ? 'logged_in')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p.widget_role_permissions) AS a(k, v)
      WHERE jsonb_typeof(v) = 'array' AND v ? 'attach_image'
    )
    AND EXISTS (
      SELECT 1 FROM jsonb_each(p.widget_role_permissions) AS b(k, v)
      WHERE jsonb_typeof(v) = 'array' AND v ? 'ticket_creator'
    )
  GROUP BY p.id
) AS rebuilt
WHERE wp.id = rebuilt.id;
